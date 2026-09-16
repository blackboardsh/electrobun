import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { getPlatformPrefix } from "../../../shared/naming";
import { ARCH, OS } from "../../../shared/platform";
import {
	Updater,
	addUpdateArtifactCacheBuster,
	atomicWriteFile,
	applyDeltaPatch,
	buildUpdateArtifactUrl,
	createDownloadProgressThrottleState,
	createNativeUpdatePlan,
	downloadResponseToFile,
	nextDownloadProgressPercent,
	preparePatchChainForUpdate,
	publishFileReplacingRegular,
	readUpdateHashFromTar,
	resolveInstalledChannelRoot,
	resolveInstalledChannelRootForPlatform,
	resolveUpdateParentPid,
	resolveUpdateHelperSource,
	syncFile,
	validateUpdateManifest,
} from "./Updater";

function fixtureRoot(): string {
	return mkdtempSync(join(tmpdir(), "electrobun-updater-v2-"));
}

function validManifest() {
	return {
		schemaVersion: 1,
		identifier: "com.example.application",
		channel: "stable",
		version: "2.0.0",
		hash: "abc123",
		platform: OS,
		arch: ARCH,
		artifact: {
			file: `${getPlatformPrefix("stable", OS, ARCH)}-Example.tar.zst`,
		},
	};
}

const textEncoder = new TextEncoder();

function concatenateBytes(parts: readonly Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
}

function writeTarField(
	header: Uint8Array,
	offset: number,
	length: number,
	value: string,
): void {
	header.set(textEncoder.encode(value).subarray(0, length), offset);
}

function tarHeader(
	name: string,
	size: number,
	type = "0",
	prefix = "",
): Uint8Array {
	const header = new Uint8Array(512);
	writeTarField(header, 0, 100, name);
	writeTarField(header, 100, 8, "0000600\0");
	writeTarField(header, 108, 8, "0000000\0");
	writeTarField(header, 116, 8, "0000000\0");
	writeTarField(header, 124, 12, `${size.toString(8).padStart(11, "0")}\0`);
	writeTarField(header, 136, 12, "00000000000\0");
	header.fill(0x20, 148, 156);
	writeTarField(header, 156, 1, type);
	writeTarField(header, 257, 6, "ustar\0");
	writeTarField(header, 263, 2, "00");
	writeTarField(header, 345, 155, prefix);
	let checksum = 0;
	for (const byte of header) checksum += byte;
	writeTarField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
	return header;
}

function tarEntry(
	name: string,
	contents: Uint8Array,
	type = "0",
	prefix = "",
): Uint8Array {
	const padding = new Uint8Array((512 - (contents.byteLength % 512)) % 512);
	return concatenateBytes([
		tarHeader(name, contents.byteLength, type, prefix),
		contents,
		padding,
	]);
}

function updateTar(hash: string, path = "Example/Resources/version.json"): Uint8Array {
	return concatenateBytes([
		tarEntry(path, textEncoder.encode(JSON.stringify({ hash }))),
		new Uint8Array(1024),
	]);
}

function paxRecordBytes(key: string, value: Uint8Array): Uint8Array {
	const body = concatenateBytes([
		textEncoder.encode(`${key}=`),
		value,
		new Uint8Array([0x0a]),
	]);
	let length = body.byteLength + 2;
	for (;;) {
		const prefix = textEncoder.encode(`${length} `);
		const actual = prefix.byteLength + body.byteLength;
		if (actual === length) return concatenateBytes([prefix, body]);
		length = actual;
	}
}

function paxRecord(key: string, value: string): Uint8Array {
	return paxRecordBytes(key, textEncoder.encode(value));
}

const expected = {
	identifier: "com.example.application",
	channel: "stable",
	platform: OS,
	arch: ARCH,
};

describe("v2 update preparation contracts", () => {
	test("accepts the canonical manifest and preserves its legacy release fields", () => {
		const document = validManifest();
		const manifest = validateUpdateManifest(document, expected);
		const legacySubset = {
			version: manifest.version,
			hash: manifest.hash,
			platform: manifest.platform,
			arch: manifest.arch,
		};
		expect(legacySubset).toEqual({
			version: document.version,
			hash: document.hash,
			platform: document.platform,
			arch: document.arch,
		});
	});

	test("ignores artifact integrity and patch descriptors from newer documents", () => {
		const document = validManifest();
		const manifest = validateUpdateManifest(
			{
				...document,
				artifact: {
					...document.artifact,
					size: 0,
					sha256: "not-a-digest",
				},
				patch: { arbitrary: true },
			},
			expected,
		);
		expect(manifest.artifact).toEqual({ file: document.artifact.file });
		expect("patch" in manifest).toBe(false);
	});

	test("rejects the non-canonical production channel", () => {
		expect(() =>
			validateUpdateManifest(
				{
					...validManifest(),
					channel: "production",
					artifact: {
						file: `production-${OS}-${ARCH}-Example.tar.zst`,
					},
				},
				{ ...expected, channel: "production" },
			),
		).toThrow("release identity");
	});

	for (const mutation of [
		{ identifier: "com.example.other" },
		{ channel: "canary" },
		{ platform: OS === "win" ? "linux" : "win" },
		{ arch: ARCH === "x64" ? "arm64" : "x64" },
		{ hash: "../escape" },
	] as const) {
		test(`rejects mismatched or unsafe metadata ${JSON.stringify(mutation)}`, () => {
			expect(() =>
				validateUpdateManifest({ ...validManifest(), ...mutation }, expected),
			).toThrow();
		});
	}

	test("rejects unsafe artifact names", () => {
		for (const artifact of [
			{ file: "../Example.tar.zst" },
			{ file: "Example.tar.zst" },
			{},
		]) {
			expect(() =>
				validateUpdateManifest({ ...validManifest(), artifact }, expected),
			).toThrow();
		}
	});

	test("accepts Hutch artifact names and URL-encodes them as one path segment", () => {
		const prefix = getPlatformPrefix("stable", OS, ARCH);
		const file = `${prefix}-Résumé's & Notes #1.tar.zst`;
		const manifest = validateUpdateManifest(
			{
				...validManifest(),
				artifact: { ...validManifest().artifact, file },
			},
			expected,
		);
		expect(manifest.artifact.file).toBe(file);
		expect(
			buildUpdateArtifactUrl("https://updates.example.test/releases/", file),
		).toBe(
			`https://updates.example.test/releases/${encodeURIComponent(file)}`,
		);
		expect(
			buildUpdateArtifactUrl("https://updates.example.test/releases/", file),
		).toBe(
			`https://updates.example.test/releases/${encodeURIComponent(file)}`,
		);
		expect(
			addUpdateArtifactCacheBuster(
				buildUpdateArtifactUrl("https://updates.example.test/releases/", file),
				"0123456789abcdef0123456789abcdef",
			),
		).toBe(
			`https://updates.example.test/releases/${encodeURIComponent(file)}?cache=0123456789abcdef0123456789abcdef`,
		);
	});

	test("bounds chunk progress and reserves 100 percent for completion", () => {
		const state = createDownloadProgressThrottleState();
		const total = 100 * 1024 * 1024;
		const emitted: number[] = [];
		for (let bytes = 64 * 1024; bytes <= total; bytes += 64 * 1024) {
			const progress = nextDownloadProgressPercent(
				state,
				Math.min(bytes, total),
				total,
				1_000,
			);
			if (progress !== null) emitted.push(progress);
		}
		expect(emitted[0]).toBe(0);
		expect(emitted.length).toBeLessThanOrEqual(100);
		expect(emitted.at(-1)).toBe(99);
		expect(emitted).not.toContain(100);
		expect(
			nextDownloadProgressPercent(state, total, total, 1_001, true),
		).toBe(100);
		expect(
			nextDownloadProgressPercent(state, total, total, 1_002, true),
		).toBeNull();
	});

	test("allows time-based progress for a slow stream without repeating a percent", () => {
		const state = createDownloadProgressThrottleState();
		expect(nextDownloadProgressPercent(state, 1, 1_000, 1_000)).toBe(0);
		expect(nextDownloadProgressPercent(state, 10, 1_000, 1_300)).toBe(1);
		expect(nextDownloadProgressPercent(state, 11, 1_000, 2_000)).toBeNull();
	});

	test("streams an update file to disk without requiring integrity metadata", async () => {
		const root = fixtureRoot();
		try {
			const bytes = new TextEncoder().encode("patch bytes");
			const destination = join(root, "patch.partial");
			expect(await downloadResponseToFile(
				new Response(bytes, {
					headers: { "content-length": "1" },
				}),
				destination,
				"Update patch",
			)).toBe(bytes.byteLength);
			expect([...readFileSync(destination)]).toEqual([...bytes]);

			const rejected = join(root, "rejected.partial");
			await expect(
				downloadResponseToFile(
					new Response(bytes),
					rejected,
					"Update patch",
					() => {
						throw new Error("interrupted");
					},
				),
			).rejects.toThrow("interrupted");
			expect(existsSync(rejected)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("applies a patch with direct argv and checks for a nonempty output", () => {
		const root = fixtureRoot();
		try {
			const bspatchPath = join(root, OS === "win" ? "bspatch.exe" : "bspatch");
			const currentTarPath = join(root, "old.tar");
			const patchPath = join(root, "old.patch");
			const outputPath = join(root, "target.partial");
			const target = new TextEncoder().encode("target tar bytes");
			for (const [path, contents] of [
				[bspatchPath, "executable"],
				[currentTarPath, "current tar"],
				[patchPath, "patch"],
			] as const) {
				writeFileSync(path, contents);
			}
			let invocation:
				| { executable: string; args: readonly string[] }
				| undefined;
			applyDeltaPatch(
				{
					bspatchPath,
					currentTarPath,
					patchPath,
					outputPath,
				},
				(executable, args) => {
					invocation = { executable, args: [...args] };
					writeFileSync(args[1]!, target);
				},
			);
			expect(invocation).toEqual({
				executable: bspatchPath,
				args: [currentTarPath, outputPath, patchPath],
			});
			expect([...readFileSync(outputPath)]).toEqual([...target]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects and removes an empty patch output", () => {
		const root = fixtureRoot();
		try {
			const bspatchPath = join(root, OS === "win" ? "bspatch.exe" : "bspatch");
			const currentTarPath = join(root, "old.tar");
			const patchPath = join(root, "old.patch");
			const outputPath = join(root, "target.partial");
			for (const path of [bspatchPath, currentTarPath, patchPath]) {
				writeFileSync(path, "input");
			}
			expect(() =>
				applyDeltaPatch(
					{
						bspatchPath,
						currentTarPath,
						patchPath,
						outputPath,
					},
					(_executable, args) => writeFileSync(args[1]!, ""),
				),
			).toThrow("empty");
			expect(existsSync(outputPath)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("reads Hutch update hashes from USTAR, PAX, and GNU long-name entries", async () => {
		const root = fixtureRoot();
		try {
			const ustarPath = join(root, "ustar.tar");
			writeFileSync(
				ustarPath,
				concatenateBytes([
					tarEntry(
						"version.json",
						textEncoder.encode(JSON.stringify({ hash: "ustarhash" })),
						"0",
						"Example/Resources",
					),
					new Uint8Array(1024),
				]),
			);
			await expect(readUpdateHashFromTar(ustarPath)).resolves.toBe("ustarhash");

			const longPath = `${"LongApplicationName".repeat(7)}/Resources/version.json`;
			const metadata = textEncoder.encode(JSON.stringify({ hash: "paxhash" }));
			const paxPath = join(root, "pax.tar");
			writeFileSync(
				paxPath,
				concatenateBytes([
					tarEntry("PaxHeaders/version", paxRecord("path", longPath), "x"),
					tarEntry("version.json", metadata),
					new Uint8Array(1024),
				]),
			);
			await expect(readUpdateHashFromTar(paxPath)).resolves.toBe("paxhash");

			const gnuPath = join(root, "gnu.tar");
			writeFileSync(
				gnuPath,
				concatenateBytes([
					tarEntry("././@LongLink", textEncoder.encode(`${longPath}\0`), "L"),
					tarEntry(
						"version.json",
						textEncoder.encode(JSON.stringify({ hash: "gnuhash" })),
					),
					new Uint8Array(1024),
				]),
			);
			await expect(readUpdateHashFromTar(gnuPath)).resolves.toBe("gnuhash");

			const unsafePath = join(root, "unsafe.tar");
			writeFileSync(unsafePath, updateTar("../escape"));
			await expect(readUpdateHashFromTar(unsafePath)).rejects.toThrow("unsafe");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("ignores opaque binary PAX xattrs while reading update metadata", async () => {
		const root = fixtureRoot();
		try {
			const hash = "xattrhash";
			const metadata = textEncoder.encode(JSON.stringify({ hash }));
			const archivePath = join(root, "binary-xattr.tar");
			const pax = concatenateBytes([
				paxRecordBytes(
					"SCHILY.xattr.com.apple.provenance",
					new Uint8Array([0xff, 0xfe, 0x00, 0x80]),
				),
				paxRecord("path", "Example/Resources/version.json"),
				paxRecord("size", String(metadata.byteLength)),
			]);
			writeFileSync(
				archivePath,
				concatenateBytes([
					tarEntry("PaxHeaders/version", pax, "x"),
					tarEntry("version.json", metadata),
					new Uint8Array(1024),
				]),
			);

			await expect(readUpdateHashFromTar(archivePath)).resolves.toBe(hash);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("prepares an unbounded two-hop filename-based patch chain atomically", async () => {
		const root = fixtureRoot();
		try {
			const currentHash = "oldhash";
			const middleHash = "middlehash";
			const latestHash = "finalhash";
			writeFileSync(join(root, `${currentHash}.tar`), "retained original");
			const manifest = validateUpdateManifest(
				{ ...validManifest(), hash: latestHash },
				expected,
			);
			const requested: string[] = [];
			const statusStart = Updater.getStatusHistory().length;
			const result = await preparePatchChainForUpdate(
				{
					info: {
						...validManifest(),
						hash: currentHash,
						baseUrl: "https://updates.example.test/releases/",
						name: "Example",
					},
					manifest,
					extractionFolder: root,
					transactionId: "a".repeat(32),
					retainedTarPath: resolve(join(root, `${latestHash}.tar`)),
				},
				{
					fetchResponse: async (url) => {
						requested.push(url);
						return new Response(
							url.endsWith(`${currentHash}.patch`) ? middleHash : latestHash,
						);
					},
					applyPatch: ({ patchPath, outputPath }) => {
						writeFileSync(outputPath, updateTar(readFileSync(patchPath, "utf8")));
					},
				},
			);
			expect(result).toEqual({ completed: true, patchesApplied: 2 });
			expect(requested).toEqual([
				`https://updates.example.test/releases/${getPlatformPrefix("stable", OS, ARCH)}-${currentHash}.patch`,
				`https://updates.example.test/releases/${getPlatformPrefix("stable", OS, ARCH)}-${middleHash}.patch`,
			]);
			await expect(
				readUpdateHashFromTar(join(root, `${latestHash}.tar`)),
			).resolves.toBe(latestHash);
			expect(readFileSync(join(root, `${currentHash}.tar`), "utf8")).toBe(
				"retained original",
			);
			expect(readdirSync(root).filter((name) => name.startsWith("."))).toEqual([]);
			const statuses = Updater.getStatusHistory().slice(statusStart);
			expect(
				statuses.filter((entry) => entry.status === "patch-applied").map((entry) => entry.details?.patchNumber),
			).toEqual([1, 2]);
			expect(statuses.find((entry) => entry.status === "patch-chain-complete")?.details?.totalPatchesApplied).toBe(2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("discards all intermediates when a later patch is missing", async () => {
		const root = fixtureRoot();
		try {
			const currentHash = "fallbackold";
			const middleHash = "fallbackmid";
			const latestHash = "fallbacknew";
			writeFileSync(join(root, `${currentHash}.tar`), "retained original");
			const result = await preparePatchChainForUpdate(
				{
					info: {
						...validManifest(),
						hash: currentHash,
						baseUrl: "https://updates.example.test/releases",
						name: "Example",
					},
					manifest: validateUpdateManifest(
						{ ...validManifest(), hash: latestHash },
						expected,
					),
					extractionFolder: root,
					transactionId: "b".repeat(32),
					retainedTarPath: resolve(join(root, `${latestHash}.tar`)),
				},
				{
					fetchResponse: async (url) =>
						url.endsWith(`${currentHash}.patch`)
							? new Response(middleHash)
							: new Response(null, { status: 404 }),
					applyPatch: ({ patchPath, outputPath }) => {
						writeFileSync(outputPath, updateTar(readFileSync(patchPath, "utf8")));
					},
				},
			);
			expect(result).toEqual({ completed: false, patchesApplied: 1 });
			expect(existsSync(join(root, `${latestHash}.tar`))).toBe(false);
			expect(readFileSync(join(root, `${currentHash}.tar`), "utf8")).toBe(
				"retained original",
			);
			expect(readdirSync(root).filter((name) => name.startsWith("."))).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects a patch-chain cycle without replacing the retained archive", async () => {
		const root = fixtureRoot();
		try {
			const currentHash = "cycleold";
			const latestHash = "cyclenew";
			writeFileSync(join(root, `${currentHash}.tar`), "retained original");
			const result = await preparePatchChainForUpdate(
				{
					info: {
						...validManifest(),
						hash: currentHash,
						baseUrl: "https://updates.example.test/releases",
						name: "Example",
					},
					manifest: validateUpdateManifest(
						{ ...validManifest(), hash: latestHash },
						expected,
					),
					extractionFolder: root,
					transactionId: "c".repeat(32),
					retainedTarPath: resolve(join(root, `${latestHash}.tar`)),
				},
				{
					fetchResponse: async () => new Response("cycle"),
					applyPatch: ({ outputPath }) => {
						writeFileSync(outputPath, updateTar(currentHash));
					},
				},
			);
			expect(result).toEqual({ completed: false, patchesApplied: 0 });
			expect(existsSync(join(root, `${latestHash}.tar`))).toBe(false);
			expect(readFileSync(join(root, `${currentHash}.tar`), "utf8")).toBe(
				"retained original",
			);
			expect(readdirSync(root).filter((name) => name.startsWith("."))).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("falls back to the bundled native manager for a v1-installed app", () => {
		const root = fixtureRoot();
		const channelRoot = join(root, "Legacy App");
		const appBundle = join(channelRoot, "app");
		const bundled =
			OS === "macos"
				? join(appBundle, "Contents", "Resources", "uninstall")
				: join(appBundle, "Resources", "uninstall");
		mkdirSync(join(bundled, ".."), { recursive: true });
		writeFileSync(bundled, "native manager");

		expect(resolveUpdateHelperSource(channelRoot, appBundle, OS)).toBe(
			bundled,
		);
	});

	test("keeps v1-installed applications in their actual legacy channel root", () => {
		const dataRoot = fixtureRoot();
		const info = {
			identifier: "com.example.application",
			channel: "stable",
			version: "2.0.0",
			hash: "abc123",
			baseUrl: "https://updates.example.invalid",
			name: "Legacy App",
		};
		const identifierRoot = join(dataRoot, info.identifier);
		const legacyRoot = join(identifierRoot, info.name);

		if (OS === "macos") {
			const retainedTar = join(
				legacyRoot,
				"self-extraction",
				`${info.hash}.tar`,
			);
			mkdirSync(join(retainedTar, ".."), { recursive: true });
			writeFileSync(retainedTar, "legacy retained state");
			expect(
				resolveInstalledChannelRoot(info, process.execPath, dataRoot),
			).toBe(resolve(legacyRoot));
		} else {
			const executable = join(
				legacyRoot,
				"app",
				"bin",
				OS === "win" ? "bun.exe" : "bun",
			);
			expect(resolveInstalledChannelRoot(info, executable, dataRoot)).toBe(
				resolve(legacyRoot),
			);
		}
	});

	test("derives Windows and Linux migration roots from the actual executable", () => {
		const info = {
			identifier: "com.example.application",
			channel: "stable",
			version: "2.0.0",
			hash: "abc123",
			baseUrl: "https://updates.example.invalid",
			name: "Legacy App",
		};
		expect(
			resolveInstalledChannelRootForPlatform(
				info,
				"win",
				"C:\\Users\\Test\\AppData\\Local\\com.example.application\\Legacy App\\app\\bin\\bun.exe",
				"C:\\Users\\Test\\AppData\\Local",
			),
		).toBe(
			win32.resolve(
				"C:\\Users\\Test\\AppData\\Local\\com.example.application\\Legacy App",
			),
		);
		expect(
			resolveInstalledChannelRootForPlatform(
				info,
				"linux",
				"/home/test/.local/share/com.example.application/Legacy App/app/bin/bun",
				"/home/test/.local/share",
			),
		).toBe(
			posix.resolve(
				"/home/test/.local/share/com.example.application/Legacy App",
			),
		);
	});

	test("selects the macOS legacy root from retained current-version state", () => {
		const info = {
			identifier: "com.example.application",
			channel: "stable",
			version: "2.0.0",
			hash: "abc123",
			baseUrl: "https://updates.example.invalid",
			name: "LegacyApp",
			displayName: "Legacy App",
		};
		const dataRoot = "/Users/test/Library/Application Support";
		const legacyRoot = posix.join(dataRoot, info.identifier, info.displayName);
		const legacyTar = posix.join(
			legacyRoot,
			"self-extraction",
			`${info.hash}.tar`,
		);
		expect(
			resolveInstalledChannelRootForPlatform(
				info,
				"macos",
				"/Applications/Legacy App.app/Contents/MacOS/bun",
				dataRoot,
				(path) => path === legacyTar,
			),
		).toBe(legacyRoot);
	});

	test("selects the early macOS canary display-name root", () => {
		const info = {
			identifier: "com.example.application",
			channel: "canary",
			version: "2.0.0",
			hash: "abc123",
			baseUrl: "https://updates.example.invalid",
			name: "LegacyApp-canary",
			displayName: "Legacy App",
		};
		const dataRoot = "/Users/test/Library/Application Support";
		const legacyRoot = posix.join(
			dataRoot,
			info.identifier,
			`${info.displayName}-${info.channel}`,
		);
		const legacyTar = posix.join(
			legacyRoot,
			"self-extraction",
			`${info.hash}.tar`,
		);
		expect(
			resolveInstalledChannelRootForPlatform(
				info,
				"macos",
				"/Applications/Legacy App-canary.app/Contents/MacOS/bun",
				dataRoot,
				(path) => path === legacyTar,
			),
		).toBe(legacyRoot);
	});

	test("selects the canonical macOS stable root from retained state", () => {
		const info = {
			identifier: "com.example.application",
			channel: "stable",
			version: "2.0.0",
			hash: "abc123",
			baseUrl: "https://updates.example.invalid",
			name: "Example App",
		};
		const dataRoot = "/Users/test/Library/Application Support";
		const stableRoot = posix.join(dataRoot, info.identifier, "stable");
		const stableTar = posix.join(
			stableRoot,
			"self-extraction",
			`${info.hash}.tar`,
		);
		const stableManifest = posix.join(
			stableRoot,
			".electrobun-uninstall.json",
		);
		expect(
			resolveInstalledChannelRootForPlatform(
				info,
				"macos",
				"/Applications/Example App.app/Contents/MacOS/bun",
				dataRoot,
				(path) => path === stableTar,
			),
		).toBe(stableRoot);
		expect(
			resolveInstalledChannelRootForPlatform(
				info,
				"macos",
				"/Applications/Example App.app/Contents/MacOS/bun",
				dataRoot,
				(path) => path === stableManifest,
			),
		).toBe(stableRoot);
	});

	test("prefers the standalone native manager once v2 registration exists", () => {
		const root = fixtureRoot();
		const channelRoot = join(root, "stable");
		const appBundle = join(channelRoot, "app");
		const bundled =
			OS === "macos"
				? join(appBundle, "Contents", "Resources", "uninstall")
				: join(appBundle, "Resources", "uninstall");
		const standalone = join(
			channelRoot,
			OS === "win" ? "uninstall.exe" : "uninstall",
		);
		mkdirSync(join(bundled, ".."), { recursive: true });
		writeFileSync(bundled, "bundled");
		writeFileSync(standalone, "standalone");

		expect(resolveUpdateHelperSource(channelRoot, appBundle, OS)).toBe(
			standalone,
		);
	});

	test("publishes replacement state through a same-directory previous swap", () => {
		const root = fixtureRoot();
		const destination = join(root, "prepared.json");
		const source = join(root, "prepared.partial");
		writeFileSync(destination, "old");
		writeFileSync(source, "new");

		publishFileReplacingRegular(source, destination);

		expect(readFileSync(destination, "utf8")).toBe("new");
		expect(existsSync(source)).toBe(false);
		expect(existsSync(`${destination}.previous`)).toBe(false);
	});

	test("durably writes update state through a Windows-compatible descriptor", () => {
		const root = fixtureRoot();
		const destination = join(root, "durable-state.json");
		atomicWriteFile(destination, new TextEncoder().encode("durable update state"));
		expect(readFileSync(destination, "utf8")).toBe("durable update state");
		expect(() => syncFile(destination)).not.toThrow();
	});

	test("creates only the exact native helper plan schema", () => {
		const root = resolve(fixtureRoot());
		const transactionId = "0123456789abcdef0123456789abcdef";
		const hash = "abc123";
		const channelRoot = join(root, "com.example.application", "stable");
		const plan = createNativeUpdatePlan({
			schema_version: 1,
			transaction_id: transactionId,
			identifier: "com.example.application",
			channel: "stable",
			platform: OS,
			arch: ARCH,
			version: "2.0.0",
			hash,
			channel_root: channelRoot,
			app_bundle_path:
				OS === "macos"
					? join(root, "Example.app")
					: join(channelRoot, "app"),
			retained_tar_path: join(
				channelRoot,
				"self-extraction",
				`${hash}.tar`,
			),
			parent_pid: 1234,
			result_path: join(
				channelRoot,
				`.electrobun-update-${transactionId}.result.json`,
			),
		});
		expect(Object.keys(plan)).toEqual([
			"schema_version",
			"transaction_id",
			"identifier",
			"channel",
			"platform",
			"arch",
			"version",
			"hash",
			"channel_root",
			"app_bundle_path",
			"retained_tar_path",
			"parent_pid",
			"result_path",
		]);
	});

	test("waits for the attested outer launcher before applying an update", () => {
		expect(resolveUpdateParentPid("4321", 1234)).toBe(4321);
		expect(resolveUpdateParentPid(undefined, 1234)).toBe(1234);
		expect(resolveUpdateParentPid("0", 1234)).toBe(1234);
		expect(resolveUpdateParentPid("12x", 1234)).toBe(1234);
		expect(resolveUpdateParentPid("2147483648", 1234)).toBe(1234);
	});

	test("contains no legacy destructive or shell-interpolated apply path", () => {
		const source = readFileSync(join(import.meta.dirname, "Updater.ts"), "utf8");
		expect(source).not.toContain("new Bun.Archive");
		expect(source).not.toContain("createWindowsUpdateBatch");
		expect(source).not.toContain('"sh", "-c"');
		expect(source).not.toContain("tasklist");
		const approval = source.indexOf("const approval = requestQuitApproval()");
		const planPublication = source.indexOf("atomicWriteJson(planPath, plan)");
		expect(approval).toBeGreaterThan(-1);
		expect(planPublication).toBeGreaterThan(approval);
	});
});
