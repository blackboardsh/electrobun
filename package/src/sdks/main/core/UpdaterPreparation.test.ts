import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { getPlatformPrefix } from "../../../shared/naming";
import { ARCH, OS } from "../../../shared/platform";
import {
	atomicWriteFile,
	applyVerifiedDeltaPatch,
	buildUpdateArtifactUrl,
	buildUpdatePatchUrl,
	createDownloadProgressThrottleState,
	createNativeUpdatePlan,
	downloadVerifiedFile,
	nextDownloadProgressPercent,
	publishFileReplacingRegular,
	resolveInstalledChannelRoot,
	resolveInstalledChannelRootForPlatform,
	resolveUpdateParentPid,
	resolveUpdateHelperSource,
	syncFile,
	validateUpdateManifest,
	verifyRegularFileIntegrity,
} from "./Updater";

function fixtureRoot(): string {
	return mkdtempSync(join(tmpdir(), "electrobun-updater-v2-"));
}

function validManifest() {
	return {
		schemaVersion: 1,
		identifier: "com.example.application",
		channel: "production",
		version: "2.0.0",
		hash: "abc123",
		platform: OS,
		arch: ARCH,
		artifact: {
			file: `${getPlatformPrefix("production", OS, ARCH)}-Example.tar.zst`,
			size: 123456,
			sha256: "a".repeat(64),
		},
	};
}

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

const expected = {
	identifier: "com.example.application",
	channel: "production",
	platform: OS,
	arch: ARCH,
};

describe("v2 update preparation contracts", () => {
	test("accepts integrity metadata while preserving the legacy manifest subset", () => {
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

	test("accepts and pins authenticated direct-patch metadata", () => {
		const prefix = getPlatformPrefix("production", OS, ARCH);
		const patch = {
			fromHash: "oldhash",
			file: `${prefix}-oldhash.patch`,
			size: 456,
			sha256: "b".repeat(64),
			targetSize: 789,
			targetSha256: "c".repeat(64),
		};
		const manifest = validateUpdateManifest(
			{ ...validManifest(), patch },
			expected,
		);
		expect(manifest.patch).toEqual(patch);
		expect(
			buildUpdatePatchUrl(
				"https://updates.example.test/releases/",
				patch.file,
				patch.sha256,
			),
		).toBe(
			`https://updates.example.test/releases/${encodeURIComponent(patch.file)}?sha256=${patch.sha256}`,
		);
	});

	test("rejects unsafe or incomplete direct-patch metadata", () => {
		const prefix = getPlatformPrefix("production", OS, ARCH);
		const validPatch = {
			fromHash: "oldhash",
			file: `${prefix}-oldhash.patch`,
			size: 456,
			sha256: "b".repeat(64),
			targetSize: 789,
			targetSha256: "c".repeat(64),
		};
		for (const patch of [
			null,
			{ ...validPatch, fromHash: "../old" },
			{ ...validPatch, file: `${prefix}-other.patch` },
			{ ...validPatch, size: 0 },
			{ ...validPatch, sha256: "B".repeat(64) },
			{ ...validPatch, targetSize: 0 },
			{ ...validPatch, targetSha256: "C".repeat(64) },
		]) {
			expect(() =>
				validateUpdateManifest({ ...validManifest(), patch }, expected),
			).toThrow();
		}
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

	test("rejects unsafe artifact names, lengths, sizes, and digests", () => {
		for (const artifact of [
			{ ...validManifest().artifact, file: "../Example.tar.zst" },
			{ ...validManifest().artifact, file: "Example.tar.zst" },
			{ ...validManifest().artifact, size: 0 },
			{ ...validManifest().artifact, size: Number.MAX_SAFE_INTEGER },
			{ ...validManifest().artifact, sha256: "A".repeat(64) },
		]) {
			expect(() =>
				validateUpdateManifest({ ...validManifest(), artifact }, expected),
			).toThrow();
		}
	});

	test("accepts Hutch artifact names and URL-encodes them as one path segment", () => {
		const prefix = getPlatformPrefix("production", OS, ARCH);
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
			buildUpdateArtifactUrl(
				"https://updates.example.test/releases/",
				file,
				"a".repeat(64),
			),
		).toBe(
			`https://updates.example.test/releases/${encodeURIComponent(file)}?sha256=${"a".repeat(64)}`,
		);
	});

	test("bounds chunk progress and reserves 100 percent for verified completion", () => {
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

	test("streams an authenticated update file to disk and removes rejected bytes", async () => {
		const root = fixtureRoot();
		try {
			const bytes = new TextEncoder().encode("authenticated patch bytes");
			const destination = join(root, "patch.partial");
			await downloadVerifiedFile(
				new Response(bytes, {
					headers: { "content-length": String(bytes.byteLength) },
				}),
				destination,
				bytes.byteLength,
				sha256(bytes),
				"Update patch",
			);
			expect(readFileSync(destination)).toEqual(Buffer.from(bytes));

			const rejected = join(root, "rejected.partial");
			await expect(
				downloadVerifiedFile(
					new Response(bytes),
					rejected,
					bytes.byteLength,
					"0".repeat(64),
					"Update patch",
				),
			).rejects.toThrow("SHA-256");
			expect(existsSync(rejected)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("applies a direct patch with argv and verifies its target before publication", async () => {
		const root = fixtureRoot();
		try {
			const bspatchPath = join(root, OS === "win" ? "bspatch.exe" : "bspatch");
			const currentTarPath = join(root, "old.tar");
			const patchPath = join(root, "old.patch");
			const outputPath = join(root, "target.partial");
			const target = new TextEncoder().encode("verified target tar bytes");
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
			await applyVerifiedDeltaPatch(
				{
					bspatchPath,
					currentTarPath,
					patchPath,
					outputPath,
					targetSize: target.byteLength,
					targetSha256: sha256(target),
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
			await expect(
				verifyRegularFileIntegrity(
					outputPath,
					target.byteLength,
					sha256(target),
					"Patched update archive",
				),
			).resolves.toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects a patch output whose target digest does not match", async () => {
		const root = fixtureRoot();
		try {
			const bspatchPath = join(root, OS === "win" ? "bspatch.exe" : "bspatch");
			const currentTarPath = join(root, "old.tar");
			const patchPath = join(root, "old.patch");
			const outputPath = join(root, "target.partial");
			for (const path of [bspatchPath, currentTarPath, patchPath]) {
				writeFileSync(path, "input");
			}
			await expect(
				applyVerifiedDeltaPatch(
					{
						bspatchPath,
						currentTarPath,
						patchPath,
						outputPath,
						targetSize: 5,
						targetSha256: "0".repeat(64),
					},
					(_executable, args) => writeFileSync(args[1]!, "wrong"),
				),
			).rejects.toThrow("SHA-256");
			expect(existsSync(outputPath)).toBe(false);
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
			channel: "production",
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
			channel: "production",
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
			channel: "production",
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

	test("selects the macOS recent-v1 stable root for a production install", () => {
		const info = {
			identifier: "com.example.application",
			channel: "production",
			version: "2.0.0",
			hash: "abc123",
			baseUrl: "https://updates.example.invalid",
			name: "Example App",
		};
		const dataRoot = "/Users/test/Library/Application Support";
		const modernRoot = posix.join(dataRoot, info.identifier, info.channel);
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
		const modernTar = posix.join(
			modernRoot,
			"self-extraction",
			`${info.hash}.tar`,
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
		expect(
			resolveInstalledChannelRootForPlatform(
				info,
				"macos",
				"/Applications/Example App.app/Contents/MacOS/bun",
				dataRoot,
				(path) => path === modernTar || path === stableTar,
			),
		).toBe(modernRoot);
	});

	test("prefers the standalone native manager once v2 registration exists", () => {
		const root = fixtureRoot();
		const channelRoot = join(root, "production");
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
		const channelRoot = join(root, "com.example.application", "production");
		const plan = createNativeUpdatePlan({
			schema_version: 1,
			transaction_id: transactionId,
			identifier: "com.example.application",
			channel: "production",
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
