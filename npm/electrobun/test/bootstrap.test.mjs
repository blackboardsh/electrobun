import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const bootstrap = require("../bin/electrobun.cjs");
const resolver = require("../bin/resolve-hutch.cjs");
const manifest = require("../package.json");
const testRoot = dirname(fileURLToPath(import.meta.url));
const originalConsoleError = console.error;

afterEach(() => {
	console.error = originalConsoleError;
});

function explicitOptions(args, runHutch) {
	return {
		args,
		environment: { ELECTROBUN_HUTCH_BINARY: "/custom/hutch" },
		existsSync: (candidate) => candidate === "/custom/hutch",
		hutchBinaryVersion: () => resolver.PAIRED_HUTCH_VERSION,
		runHutch,
	};
}

function writeCachedHutch(
	root,
	platformKey = "linux-x64",
	platform = "linux",
	body = "cached",
	sealed = true,
) {
	const extension = platform === "win32" ? ".exe" : "";
	mkdirSync(join(root, "bin"), { recursive: true });
	const launcher = join(root, "bin", `hutch${extension}`);
	const engine = join(root, "bin", `hutch-engine${extension}`);
	const metadata = join(root, "hutch-release.json");
	writeFileSync(launcher, body, { mode: 0o755 });
	writeFileSync(engine, "engine", {
		mode: 0o755,
	});
	if (platform !== "win32") {
		chmodSync(launcher, 0o755);
		chmodSync(engine, 0o755);
	}
	writeFileSync(
		metadata,
		JSON.stringify({
			schema: 1,
			kind: "archive",
			product: "hutch",
			version: resolver.PAIRED_HUTCH_VERSION,
			platform: platformKey,
			launcher: `bin/hutch${extension}`,
			executable: `bin/hutch-engine${extension}`,
		}),
	);
	if (sealed) {
		const files = {};
		for (const [relative, file] of [
			[`bin/hutch${extension}`, launcher],
			[`bin/hutch-engine${extension}`, engine],
			["hutch-release.json", metadata],
		]) {
			const bytes = readFileSync(file);
			files[relative] = {
				size: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				...(platform !== "win32" && relative.startsWith("bin/")
					? { mode: 0o755 }
					: {}),
			};
		}
		const cacheManifest = join(root, resolver.CACHE_MANIFEST_FILENAME);
		writeFileSync(
			cacheManifest,
			`${JSON.stringify({
				schemaVersion: 1,
				electrobunVersion: manifest.version,
				hutchVersion: resolver.PAIRED_HUTCH_VERSION,
				platform: platformKey,
				archiveSha256: "0".repeat(64),
				files,
			})}\n`,
			{ mode: 0o444 },
		);
	}
	return launcher;
}

function writeCacheLockOwner(
	lock,
	{
		createdAt = Date.now(),
		pid = process.pid,
		token = "a".repeat(32),
	} = {},
) {
	mkdirSync(lock, { recursive: true });
	writeFileSync(
		join(lock, resolver.CACHE_LOCK_OWNER_FILENAME),
		`${JSON.stringify({ schemaVersion: 1, pid, createdAt, token })}\n`,
		{ mode: 0o444 },
	);
	return token;
}

function makeArchive(
	temporary,
	platformKey = "linux-x64",
	platform = "linux",
	binaryMode = null,
) {
	const rootName = `hutch-v${resolver.PAIRED_HUTCH_VERSION}-${platformKey}`;
	const staging = join(temporary, "archive-staging");
	const root = join(staging, rootName);
	writeCachedHutch(root, platformKey, platform, "downloaded", false);
	if (binaryMode !== null && platform !== "win32") {
		chmodSync(join(root, "bin", "hutch"), binaryMode);
		chmodSync(join(root, "bin", "hutch-engine"), binaryMode);
	}
	const archivePath = join(temporary, "hutch.tar.gz");
	execFileSync("tar", ["-czf", archivePath, "-C", staging, rootName]);
	return readFileSync(archivePath);
}

function artifactIndex(baseUrl, selectedPlatform, selectedArchive) {
	const platforms = {};
	for (const platform of [
		"macos-arm64",
		"linux-arm64",
		"linux-x64",
		"windows-x64",
	]) {
		const bytes = platform === selectedPlatform ? selectedArchive : Buffer.from(platform);
		const filename = `electrobun-hutch-${platform}.tar.gz`;
		platforms[platform] = {
			archive: {
				url: `${baseUrl}/v${manifest.version}/${filename}`,
				size: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
		};
	}
	return Buffer.from(
		JSON.stringify({
			schemaVersion: 1,
			product: { name: "electrobun", version: manifest.version },
			hutch: { version: resolver.PAIRED_HUTCH_VERSION },
			platforms,
		}),
	);
}

function artifactDownloads(baseUrl, platform, archive, index = artifactIndex(baseUrl, platform, archive)) {
	return new Map([
		[`${baseUrl}/v${manifest.version}/hutch-artifacts.json`, index],
		[`${baseUrl}/v${manifest.version}/electrobun-hutch-${platform}.tar.gz`, archive],
	]);
}

test("uses stable templates by default and preserves explicit template channels", async () => {
	let forwarded;
	await bootstrap.main(
		explicitOptions(["init", "my-app"], (call) => {
			forwarded = call.args;
			return 0;
		}),
	);
	assert.deepEqual(forwarded, [
		"electrobun",
		"init",
		"my-app",
		"--channel=stable",
	]);

	assert.deepEqual(bootstrap.hutchArguments(["init", "my-app", "--beta"]), [
		"init",
		"my-app",
		"--beta",
	]);
	assert.deepEqual(bootstrap.hutchArguments(["init", "--channel=beta"]), [
		"init",
		"--channel=beta",
	]);
});

test("forwards every non-init command and argument unchanged", async () => {
	const args = ["build", "--env=canary", "--", "--literal", "value with spaces"];
	let forwarded;
	await bootstrap.main(
		explicitOptions(args, (call) => {
			forwarded = call.args;
			return 0;
		}),
	);
	assert.deepEqual(forwarded, ["electrobun", ...args]);
});

test("paired toolchain versions are supplied as defaults, never overrides", () => {
	const enriched = resolver.environmentWithPairedDefaults({});
	assert.equal(enriched.HUTCH_DEFAULT_CLI, resolver.PAIRED_HUTCH_VERSION);
	assert.equal(enriched.HUTCH_DEFAULT_ELECTROBUN, manifest.version);
	assert.equal(enriched.HUTCH_DEFAULT_COTTONTAIL, undefined);

	const preset = resolver.environmentWithPairedDefaults({
		HUTCH_DEFAULT_CLI: "9.9.9",
		HUTCH_DEFAULT_ELECTROBUN: "7.7.7",
	});
	assert.equal(preset.HUTCH_DEFAULT_CLI, "9.9.9");
	assert.equal(preset.HUTCH_DEFAULT_ELECTROBUN, "7.7.7");
});

test("downloads and paired-version probes have finite timeouts", async () => {
	let probeOptions;
	assert.equal(
		resolver.hutchBinaryVersion("/custom/hutch", {}, (_binary, _args, options) => {
			probeOptions = options;
			return { status: 0, stdout: `${resolver.PAIRED_HUTCH_VERSION}\n` };
		}),
		resolver.PAIRED_HUTCH_VERSION,
	);
	assert.ok(Number.isFinite(probeOptions.timeout) && probeOptions.timeout > 0);
	assert.equal(probeOptions.cwd, parse(resolve(tmpdir())).root);
	assert.equal(probeOptions.env.PWD, probeOptions.cwd);

	let timeoutHandler;
	let errorHandler;
	let requestTimeout;
	const request = {
		destroy(error) {
			errorHandler(error);
		},
		on(event, handler) {
			if (event === "error") errorHandler = handler;
		},
		setTimeout(milliseconds, handler) {
			requestTimeout = milliseconds;
			timeoutHandler = handler;
		},
	};
	const pending = resolver.download("https://releases.test/asset", {
		label: "test download",
		requestGet: () => request,
	});
	assert.ok(Number.isFinite(requestTimeout) && requestTimeout > 0);
	timeoutHandler();
	await assert.rejects(pending, /test download timed out/);
});

test("paired-version probes cannot inherit a shared-temp Hutch project config", () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-probe-cwd-"));
	try {
		writeFileSync(join(temporary, "hutch.config.ts"), "throw new Error('must not load');\n");
		const sharedTemporaryDirectory = join(temporary, "nested", "shared-temp");
		mkdirSync(sharedTemporaryDirectory, { recursive: true });
		let cwd;
		const version = resolver.hutchBinaryVersion(
			"/custom/hutch",
			{},
			(_binary, _args, options) => {
				cwd = options.cwd;
				return { status: 0, stdout: `${resolver.PAIRED_HUTCH_VERSION}\n` };
			},
			sharedTemporaryDirectory,
		);
		assert.equal(version, resolver.PAIRED_HUTCH_VERSION);
		assert.equal(cwd, parse(resolve(sharedTemporaryDirectory)).root);
		assert.equal(resolve(cwd).startsWith(`${resolve(temporary)}/`), false);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("maps exactly the four published Hutch release platforms", () => {
	assert.equal(resolver.hutchPlatformKey("darwin", "arm64"), "macos-arm64");
	assert.equal(resolver.hutchPlatformKey("linux", "arm64"), "linux-arm64");
	assert.equal(resolver.hutchPlatformKey("linux", "x64"), "linux-x64");
	assert.equal(resolver.hutchPlatformKey("win32", "x64"), "windows-x64");
	assert.equal(resolver.hutchPlatformKey("darwin", "x64"), null);
	assert.equal(resolver.hutchPlatformKey("win32", "arm64"), null);
});

test("downloads, verifies, safely extracts, and reuses the exact cached release offline", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-"));
	const cacheRoot = join(temporary, "cache");
	const baseUrl = "https://releases.test";
	try {
		const archive = makeArchive(temporary);
		const downloads = artifactDownloads(baseUrl, "linux-x64", archive);
		const calls = [];
		const binary = await resolver.resolveHutchBinary({
			arch: "x64",
			cacheRoot,
			download: async (url) => {
				calls.push(url);
				const bytes = downloads.get(url);
				if (!bytes) throw new Error(`unexpected download ${url}`);
				return bytes;
			},
			environment: {
				ELECTROBUN_RELEASES_BASE_URL: baseUrl,
				HUTCH_HOME: join(temporary, "hutch-home"),
			},
			installHutch: async () => {
				throw new Error("global fallback must not run");
			},
			platform: "linux",
			userHome: temporary,
		});
		assert.equal(binary, join(cacheRoot, "bin", "hutch"));
		assert.equal(readFileSync(binary, "utf8"), "downloaded");
		assert.deepEqual(calls, [...downloads.keys()]);

		let offlineDownloads = 0;
		const warm = await resolver.resolveHutchBinary({
			arch: "x64",
			cacheRoot,
			download: async () => {
				offlineDownloads += 1;
				throw new Error("offline cache must not download");
			},
			environment: {
				DASH_RELEASE_OFFLINE: "1",
				HUTCH_HOME: join(temporary, "hutch-home"),
			},
			platform: "linux",
			userHome: temporary,
		});
		assert.equal(warm, binary);
		assert.equal(offlineDownloads, 0);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("offline warm-cache validation rejects modified Hutch bytes", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-corrupt-"));
	const cacheRoot = join(temporary, "cache");
	try {
		writeCachedHutch(cacheRoot);
		const engine = join(cacheRoot, "bin", "hutch-engine");
		writeFileSync(engine, Buffer.alloc(readFileSync(engine).length, 0));
		assert.equal(
			resolver.validateCachedHutch(cacheRoot, "linux-x64", "linux"),
			null,
		);
		await assert.rejects(
			resolver.resolveHutchBinary({
				arch: "x64",
				cacheRoot,
				environment: { DASH_RELEASE_OFFLINE: "1" },
				existsSync: () => false,
				platform: "linux",
				userHome: temporary,
			}),
			/npm cache.*DASH_RELEASE_OFFLINE/,
		);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test(
	"fresh extraction normalizes and seals both Hutch executable modes",
	{ skip: process.platform === "win32" },
	() => {
		const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-seal-mode-"));
		const root = join(temporary, "cache");
		try {
			const binary = resolver.installDownloadedArchive({
				archive: makeArchive(temporary, "linux-x64", "linux", 0o401),
				environment: {},
				platform: "linux",
				platformKey: "linux-x64",
				root,
			});
			const engine = join(root, "bin", "hutch-engine");
			assert.equal(statSync(binary).mode & 0o777, 0o755);
			assert.equal(statSync(engine).mode & 0o777, 0o755);
			const cache = JSON.parse(
				readFileSync(join(root, resolver.CACHE_MANIFEST_FILENAME), "utf8"),
			);
			assert.equal(cache.files["bin/hutch"].mode, 0o755);
			assert.equal(cache.files["bin/hutch-engine"].mode, 0o755);
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	},
);

test(
	"warm-cache validation accepts executable modes normalized by limited filesystems",
	{ skip: process.platform === "win32" },
	() => {
		const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-fs-mode-"));
		const root = join(temporary, "cache");
		try {
			const binary = writeCachedHutch(root);
			const engine = join(root, "bin", "hutch-engine");
			const marker = join(root, resolver.CACHE_MANIFEST_FILENAME);
			chmodSync(binary, 0o700);
			chmodSync(engine, 0o700);
			chmodSync(marker, 0o600);
			const cache = JSON.parse(readFileSync(marker, "utf8"));
			cache.files["bin/hutch"].mode = 0o700;
			cache.files["bin/hutch-engine"].mode = 0o700;
			writeFileSync(marker, `${JSON.stringify(cache)}\n`);
			chmodSync(marker, 0o700);
			assert.equal(
				resolver.validateCachedHutch(root, "linux-x64", "linux"),
				binary,
			);
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	},
);

test(
	"offline warm-cache validation rejects non-executable Hutch launchers",
	{ skip: process.platform === "win32" },
	async () => {
		const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-mode-"));
		try {
			for (const mode of [0o644, 0o401, 0o777]) {
				const cacheRoot = join(temporary, `cache-${mode.toString(8)}`);
				const binary = writeCachedHutch(cacheRoot);
				chmodSync(binary, mode);
				assert.equal(
					resolver.validateCachedHutch(cacheRoot, "linux-x64", "linux"),
					null,
					`mode ${mode.toString(8)} must not validate`,
				);
				await assert.rejects(
					resolver.resolveHutchBinary({
						arch: "x64",
						cacheRoot,
						environment: { DASH_RELEASE_OFFLINE: "1" },
						existsSync: () => false,
						platform: "linux",
						userHome: temporary,
					}),
					/npm cache.*DASH_RELEASE_OFFLINE/,
				);
			}
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	},
);

test("rejects a checksum mismatch instead of installing the archive", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-"));
	const baseUrl = "https://releases.test";
	try {
		const archive = makeArchive(temporary);
		const index = JSON.parse(artifactIndex(baseUrl, "linux-x64", archive));
		index.platforms["linux-x64"].archive.sha256 = "0".repeat(64);
		const downloads = artifactDownloads(
			baseUrl,
			"linux-x64",
			archive,
			Buffer.from(JSON.stringify(index)),
		);
		console.error = () => {};
		await assert.rejects(
			resolver.resolveHutchBinary({
				arch: "x64",
				cacheRoot: join(temporary, "cache"),
				download: async (url) => downloads.get(url),
				environment: {
					ELECTROBUN_RELEASES_BASE_URL: baseUrl,
					HUTCH_HOME: join(temporary, "home"),
				},
				installHutch: async () => {
					throw new Error("no global fallback");
				},
				platform: "linux",
				userHome: temporary,
			}),
			/SHA-256 does not match.*global fallback failed/s,
		);
		assert.equal(existsSync(join(temporary, "cache")), false);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("rejects unsafe archive paths before extraction", () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-"));
	try {
		let extracted = false;
		assert.throws(
			() =>
				resolver.installDownloadedArchive({
					archive: Buffer.from("not-a-real-archive"),
					environment: {},
					execute: (_command, args) => {
						if (args[0] === "-tzf") return "../escaped\n";
						if (args[0] === "-tvzf") return "-rw-r--r-- user group 1 date ../escaped\n";
						extracted = true;
					},
					platform: "linux",
					platformKey: "linux-x64",
					root: join(temporary, "cache"),
				}),
			/unsafe path/,
		);
		assert.equal(extracted, false);
		assert.equal(existsSync(join(temporary, "escaped")), false);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("uses the Windows system tar for archive validation", () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-win-tar-"));
	const commands = [];
	try {
		assert.throws(
			() =>
				resolver.installDownloadedArchive({
					archive: Buffer.from("not-a-real-archive"),
					environment: { SystemRoot: "C:\\Windows" },
					execute: (command, args) => {
						commands.push(command);
						if (args[0] === "-tzf") return "../escaped\n";
						if (args[0] === "-tvzf") {
							return "-rw-r--r-- user group 1 date ../escaped\n";
						}
					},
					platform: "win32",
					platformKey: "windows-x64",
					root: join(temporary, "cache"),
				}),
			/unsafe path/,
		);
		assert.deepEqual(commands, [
			"C:\\Windows\\System32\\tar.exe",
			"C:\\Windows\\System32\\tar.exe",
		]);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("Windows archive commands keep Unicode cache paths out of tar argv", () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-unicode-"));
	const unicodeParent = join(temporary, "用戶-électrobun");
	const root = join(unicodeParent, "cache");
	try {
		const archive = makeArchive(temporary, "windows-x64", "win32");
		const calls = [];
		const binary = resolver.installDownloadedArchive({
			archive,
			environment: {},
			execute: (command, args, options) => {
				calls.push({ args: [...args], cwd: options.cwd });
				return execFileSync(command, args, options);
			},
			platform: "win32",
			platformKey: "windows-x64",
			root,
			tarExecutable: "tar",
		});
		assert.equal(readFileSync(binary, "utf8"), "downloaded");
		assert.equal(calls.length, 6);
		for (const call of calls) {
			assert.equal(call.cwd.includes("用戶-électrobun"), true);
			assert.equal(call.args.some((argument) => argument.includes("用戶-électrobun")), false);
			assert.equal(call.args.includes("-C"), false);
			assert.equal(call.args[1], "hutch.tar.gz");
		}
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("rejects oversized extracted archive members before writing them to disk", () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-size-"));
	const rootName = `hutch-v${resolver.PAIRED_HUTCH_VERSION}-linux-x64`;
	const entries = [
		`${rootName}/`,
		`${rootName}/bin/`,
		`${rootName}/bin/hutch`,
		`${rootName}/bin/hutch-engine`,
		`${rootName}/hutch-release.json`,
	];
	let extracted = false;
	try {
		assert.throws(
			() =>
				resolver.installDownloadedArchive({
					archive: Buffer.from("not-a-real-archive"),
					environment: {},
					execute: (_command, args, options) => {
						if (args[0] === "-tzf") return `${entries.join("\n")}\n`;
						if (args[0] === "-tvzf") {
							return `${entries.map((entry, index) => `${index < 2 ? "d" : "-"} entry ${entry}`).join("\n")}\n`;
						}
						if (args[0] === "-xOzf") {
							return args[2].endsWith("hutch-release.json")
								? Buffer.alloc(options.maxBuffer + 1)
								: Buffer.from("member");
						}
						extracted = true;
					},
					platform: "linux",
					platformKey: "linux-x64",
					root: join(temporary, "cache"),
				}),
			/size limit/,
		);
		assert.equal(extracted, false);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("a concurrent valid cache wins without being deleted or replaced", () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-race-"));
	const root = join(temporary, "cache");
	try {
		const archive = makeArchive(temporary);
		let injectedRace = false;
		const binary = resolver.installDownloadedArchive({
			archive,
			environment: {},
			platform: "linux",
			platformKey: "linux-x64",
			rename: (source, destination) => {
				if (!injectedRace && destination === root) {
					injectedRace = true;
					writeCachedHutch(root, "linux-x64", "linux", "raced-valid");
					const error = new Error("destination exists");
					error.code = "EEXIST";
					throw error;
				}
				renameSync(source, destination);
			},
			root,
		});
		assert.equal(injectedRace, true);
		assert.equal(binary, join(root, "bin", "hutch"));
		assert.equal(readFileSync(binary, "utf8"), "raced-valid");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("continues when another installer first quarantines an invalid cache", () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-invalid-race-"));
	const root = join(temporary, "cache");
	const otherQuarantine = join(temporary, "other-installer-invalid");
	try {
		mkdirSync(root);
		writeFileSync(join(root, "partial"), "invalid");
		const archive = makeArchive(temporary);
		let injectedRace = false;
		const binary = resolver.installDownloadedArchive({
			archive,
			environment: {},
			platform: "linux",
			platformKey: "linux-x64",
			rename: (source, destination) => {
				if (!injectedRace && source === root) {
					injectedRace = true;
					renameSync(source, otherQuarantine);
					const error = new Error("source disappeared");
					error.code = "ENOENT";
					throw error;
				}
				renameSync(source, destination);
			},
			root,
		});
		assert.equal(injectedRace, true);
		assert.equal(binary, join(root, "bin", "hutch"));
		assert.equal(readFileSync(binary, "utf8"), "downloaded");
		assert.equal(readFileSync(join(otherQuarantine, "partial"), "utf8"), "invalid");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("a failed quarantine rename never deletes an unowned destination", () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-quarantine-owner-"));
	const root = join(temporary, "cache");
	let sentinel;
	try {
		mkdirSync(root);
		writeFileSync(join(root, "partial"), "invalid");
		assert.throws(
			() =>
				resolver.installDownloadedArchive({
					archive: makeArchive(temporary),
					environment: {},
					platform: "linux",
					platformKey: "linux-x64",
					rename: (source, destination) => {
						if (source === root) {
							mkdirSync(destination);
							sentinel = join(destination, "belongs-to-another-process");
							writeFileSync(sentinel, "keep");
							const error = new Error("destination already exists");
							error.code = "EEXIST";
							throw error;
						}
						renameSync(source, destination);
					},
					root,
				}),
			/destination already exists/,
		);
		assert.equal(readFileSync(sentinel, "utf8"), "keep");
		assert.equal(readFileSync(join(root, "partial"), "utf8"), "invalid");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("revalidates under the cache lock and never quarantines a raced valid cache", () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-lock-race-"));
	const root = join(temporary, "cache");
	try {
		mkdirSync(root);
		writeFileSync(join(root, "partial"), "invalid");
		const archive = makeArchive(temporary);
		let injectedRace = false;
		let rootMoves = 0;
		const binary = resolver.installDownloadedArchive({
			archive,
			environment: {},
			makeLockDirectory: (claim) => {
				assert.match(claim, new RegExp(`${root}\\.install-lock\\.claim-`));
				mkdirSync(claim);
			},
			platform: "linux",
			platformKey: "linux-x64",
			rename: (source, destination) => {
				if (
					!injectedRace &&
					destination === `${root}.install-lock` &&
					source.includes(".install-lock.claim-")
				) {
				rmSync(root, { force: true, recursive: true });
				writeCachedHutch(root, "linux-x64", "linux", "raced-valid");
				injectedRace = true;
				}
				if (source === root) rootMoves += 1;
				renameSync(source, destination);
			},
			root,
		});
		assert.equal(injectedRace, true);
		assert.equal(rootMoves, 0);
		assert.equal(readFileSync(binary, "utf8"), "raced-valid");
		assert.equal(existsSync(`${root}.install-lock`), false);
		assert.deepEqual(
			readdirSync(temporary).filter((entry) => entry.includes(".invalid-")),
			[],
		);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("recovers malformed, empty, and dead-owner locks but never a live owner", () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-stale-lock-"));
	const common = {
		expectedHutchVersion: resolver.PAIRED_HUTCH_VERSION,
		platform: "linux",
		platformKey: "linux-x64",
		sleep: () => {},
		timeoutMs: 0,
	};
	try {
		for (const kind of ["empty", "malformed-orphan", "dead-owner"]) {
			const root = join(temporary, kind, "cache");
			mkdirSync(dirname(root), { recursive: true });
			const lockPath = `${root}.install-lock`;
			if (kind === "empty" || kind === "malformed-orphan") {
				mkdirSync(lockPath);
				if (kind === "malformed-orphan") {
					writeFileSync(join(lockPath, "orphaned.json"), "{partial");
				}
				const old = new Date(Date.now() - 120_000);
				utimesSync(lockPath, old, old);
			} else {
				writeCacheLockOwner(lockPath, { pid: 999_999_999 });
			}
			const acquired = resolver.acquireCacheLock({
				...common,
				isProcessAlive: () => false,
				root,
			});
			assert.equal(existsSync(lockPath), true);
			acquired.release();
			assert.equal(existsSync(lockPath), false);
			assert.equal(
				readdirSync(dirname(root)).some((entry) =>
					entry.startsWith(`${kind === "empty" ? "cache" : "cache"}.install-lock.reclaimed-`),
				),
				true,
			);
		}

		const liveRoot = join(temporary, "live", "cache");
		mkdirSync(dirname(liveRoot), { recursive: true });
		writeCachedHutch(liveRoot);
		const liveLock = `${liveRoot}.install-lock`;
		const liveToken = writeCacheLockOwner(liveLock, {
			createdAt: Date.now() - 120_000,
			pid: process.pid,
			token: "b".repeat(32),
		});
		assert.throws(
			() => resolver.acquireCacheLock({ ...common, root: liveRoot }),
			/timed out waiting for Hutch cache lock/,
		);
		assert.equal(
			JSON.parse(readFileSync(join(liveLock, resolver.CACHE_LOCK_OWNER_FILENAME))).token,
			liveToken,
		);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("a delayed stale-lock reclaimer cannot move a replacement live owner", () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-reclaim-aba-"));
	const root = join(temporary, "cache");
	const lockPath = `${root}.install-lock`;
	const oldToken = "c".repeat(32);
	const replacementToken = "d".repeat(32);
	mkdirSync(temporary, { recursive: true });
	writeCacheLockOwner(lockPath, { pid: 999_999_999, token: oldToken });
	let injectedWinner = false;
	try {
		assert.throws(
			() =>
				resolver.acquireCacheLock({
					expectedHutchVersion: resolver.PAIRED_HUTCH_VERSION,
					isProcessAlive: (pid) => pid === process.pid,
					platform: "linux",
					platformKey: "linux-x64",
					rename: (source, destination) => {
						if (!injectedWinner && destination.endsWith("/stale-lock")) {
							injectedWinner = true;
							renameSync(source, destination);
							writeCacheLockOwner(lockPath, {
								pid: process.pid,
								token: replacementToken,
							});
							// Windows reports EPERM (rather than ENOTEMPTY) when the delayed
							// loser reaches the populated deterministic tombstone.
							const error = new Error("tombstone fence is populated");
							error.code = "EPERM";
							throw error;
						}
						renameSync(source, destination);
					},
					root,
					sleep: () => {},
					timeoutMs: 0,
				}),
			/timed out waiting for Hutch cache lock/,
		);
		assert.equal(injectedWinner, true);
		assert.equal(
			JSON.parse(readFileSync(join(lockPath, resolver.CACHE_LOCK_OWNER_FILENAME))).token,
			replacementToken,
		);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("transient reclaim EPERM backs off and respects the lock deadline", () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-reclaim-eperm-"));
	const root = join(temporary, "cache");
	const lockPath = `${root}.install-lock`;
	mkdirSync(temporary, { recursive: true });
	writeCacheLockOwner(lockPath, { pid: 999_999_999, token: "8".repeat(32) });
	let clock = 0;
	let reclaimAttempts = 0;
	let sleeps = 0;
	try {
		assert.throws(
			() =>
				resolver.acquireCacheLock({
					expectedHutchVersion: resolver.PAIRED_HUTCH_VERSION,
					isProcessAlive: () => false,
					now: () => clock,
					platform: "linux",
					platformKey: "linux-x64",
					rename: (source, destination) => {
						if (source === lockPath && destination.endsWith("/stale-lock")) {
							reclaimAttempts += 1;
							const error = new Error("simulated antivirus contention");
							error.code = "EPERM";
							throw error;
						}
						renameSync(source, destination);
					},
					root,
					sleep: (milliseconds) => {
						sleeps += 1;
						clock += milliseconds;
					},
					timeoutMs: 1,
				}),
			/timed out waiting for Hutch cache lock/,
		);
		assert.equal(reclaimAttempts, 2);
		assert.equal(sleeps, 1);
		assert.equal(
			JSON.parse(readFileSync(join(lockPath, resolver.CACHE_LOCK_OWNER_FILENAME))).token,
			"8".repeat(32),
		);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("lock release removes only its token-owned quarantine across replacement ABA", () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-release-aba-"));
	const root = join(temporary, "cache");
	const lockPath = `${root}.install-lock`;
	const replacementToken = "e".repeat(32);
	mkdirSync(temporary, { recursive: true });
	let installedReplacement = false;
	try {
		const acquired = resolver.acquireCacheLock({
			expectedHutchVersion: resolver.PAIRED_HUTCH_VERSION,
			platform: "linux",
			platformKey: "linux-x64",
			rename: (source, destination) => {
				renameSync(source, destination);
				if (source === lockPath && destination.includes(".released-")) {
					writeCacheLockOwner(lockPath, {
						pid: process.pid,
						token: replacementToken,
					});
					installedReplacement = true;
				}
			},
			root,
		});
		acquired.release();
		assert.equal(installedReplacement, true);
		assert.equal(
			JSON.parse(readFileSync(join(lockPath, resolver.CACHE_LOCK_OWNER_FILENAME))).token,
			replacementToken,
		);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("a failed release move is marked and recovered without waiting for owner exit", () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-release-recover-"));
	const root = join(temporary, "cache");
	const lockPath = `${root}.install-lock`;
	mkdirSync(temporary, { recursive: true });
	try {
		const first = resolver.acquireCacheLock({
			expectedHutchVersion: resolver.PAIRED_HUTCH_VERSION,
			platform: "linux",
			platformKey: "linux-x64",
			rename: (source, destination) => {
				if (source === lockPath && destination.includes(".released-")) {
					const error = new Error("simulated release move failure");
					error.code = "EACCES";
					throw error;
				}
				renameSync(source, destination);
			},
			root,
		});
		first.release();
		assert.equal(existsSync(lockPath), true);

		const second = resolver.acquireCacheLock({
			expectedHutchVersion: resolver.PAIRED_HUTCH_VERSION,
			platform: "linux",
			platformKey: "linux-x64",
			root,
			timeoutMs: 0,
		});
		second.release();
		assert.equal(existsSync(lockPath), false);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("a prepared claim retries when the winning lock is released before recheck", () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-claim-retry-"));
	const root = join(temporary, "cache");
	const lockPath = `${root}.install-lock`;
	mkdirSync(temporary, { recursive: true });
	let injectedWinner = false;
	try {
		const acquired = resolver.acquireCacheLock({
			expectedHutchVersion: resolver.PAIRED_HUTCH_VERSION,
			platform: "linux",
			platformKey: "linux-x64",
			rename: (source, destination) => {
				if (!injectedWinner && destination === lockPath) {
					injectedWinner = true;
					writeCacheLockOwner(lockPath, { token: "f".repeat(32) });
					rmSync(lockPath, { force: true, recursive: true });
					const error = new Error("lost atomic claim race");
					error.code = "EEXIST";
					throw error;
				}
				renameSync(source, destination);
			},
			root,
			timeoutMs: 100,
		});
		assert.equal(injectedWinner, true);
		assert.equal(existsSync(lockPath), true);
		acquired.release();
		assert.equal(existsSync(lockPath), false);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("persistent atomic-claim access errors back off and respect the lock timeout", () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-claim-eperm-"));
	mkdirSync(temporary, { recursive: true });
	try {
		for (const code of ["EACCES", "EBUSY", "EPERM"]) {
			const root = join(temporary, code, "cache");
			mkdirSync(dirname(root), { recursive: true });
			let clock = 0;
			let sleeps = 0;
			let renames = 0;
			assert.throws(
				() =>
					resolver.acquireCacheLock({
						expectedHutchVersion: resolver.PAIRED_HUTCH_VERSION,
						now: () => clock,
						platform: "linux",
						platformKey: "linux-x64",
						rename: () => {
							renames += 1;
							const error = new Error("simulated antivirus lock");
							error.code = code;
							throw error;
						},
						root,
						sleep: (milliseconds) => {
							sleeps += 1;
							clock += milliseconds;
						},
						timeoutMs: 1,
					}),
				/timed out waiting for Hutch cache lock/,
			);
			assert.equal(sleeps, 1, code);
			assert.equal(renames, 2, code);
		}
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("a cleanup failure after cache commit cannot roll back the published cache", () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-commit-"));
	const root = join(temporary, "cache");
	try {
		mkdirSync(root);
		writeFileSync(join(root, "partial"), "invalid");
		const archive = makeArchive(temporary);
		let cleanupFailed = false;
		let waiterBlocked = false;
		const binary = resolver.installDownloadedArchive({
			archive,
			environment: {},
			platform: "linux",
			platformKey: "linux-x64",
			remove: (target, options) => {
				if (!cleanupFailed && target.includes(".invalid-")) {
					cleanupFailed = true;
					assert.throws(
						() =>
							resolver.acquireCacheLock({
								expectedHutchVersion: resolver.PAIRED_HUTCH_VERSION,
								platform: "linux",
								platformKey: "linux-x64",
								root,
								sleep: () => {},
								timeoutMs: 0,
							}),
						/timed out waiting for Hutch cache lock/,
					);
					waiterBlocked = true;
					const error = new Error("simulated quarantine cleanup failure");
					error.code = "EACCES";
					throw error;
				}
				rmSync(target, options);
			},
			root,
		});
		assert.equal(cleanupFailed, true);
		assert.equal(waiterBlocked, true);
		assert.equal(readFileSync(binary, "utf8"), "downloaded");
		assert.equal(
			resolver.validateCachedHutch(root, "linux-x64", "linux"),
			binary,
		);
		assert.equal(existsSync(`${root}.install-lock`), false);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("transient Windows rename errors retry quarantine and final publication", () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-rename-retry-"));
	try {
		for (const existingInvalid of [true, false]) {
			const root = join(temporary, existingInvalid ? "invalid" : "empty", "cache");
			mkdirSync(dirname(root), { recursive: true });
			if (existingInvalid) {
				mkdirSync(root);
				writeFileSync(join(root, "partial"), "invalid");
			}
			let transientFailures = 0;
			let cleanupAttempts = 0;
			const binary = resolver.installDownloadedArchive({
				archive: makeArchive(join(temporary, existingInvalid ? "archive-a" : "archive-b")),
				cleanup: (target, options) => {
					cleanupAttempts += 1;
					if (!existingInvalid) {
						const error = new Error("simulated committed temp cleanup hold");
						error.code = "EBUSY";
						throw error;
					}
					rmSync(target, options);
				},
				environment: {},
				platform: "linux",
				platformKey: "linux-x64",
				rename: (source, destination) => {
					const targetRename = existingInvalid
						? source === root && destination.includes(".invalid-")
						: destination === root;
					if (targetRename && transientFailures === 0) {
						transientFailures += 1;
						const error = new Error("simulated transient Windows rename hold");
						error.code = existingInvalid ? "EACCES" : "EPERM";
						throw error;
					}
					renameSync(source, destination);
				},
				root,
				sleep: () => {},
			});
			assert.equal(transientFailures, 1);
			assert.equal(cleanupAttempts, 1);
			assert.equal(readFileSync(binary, "utf8"), "downloaded");
			assert.equal(
				resolver.validateCachedHutch(root, "linux-x64", "linux"),
				binary,
			);
		}
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test(
	"replaces a dangling cache-root symlink instead of falling back",
	{ skip: process.platform === "win32" },
	() => {
		const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-hutch-dangling-"));
		const root = join(temporary, "cache");
		try {
			symlinkSync(join(temporary, "missing"), root);
			const binary = resolver.installDownloadedArchive({
				archive: makeArchive(temporary),
				environment: {},
				platform: "linux",
				platformKey: "linux-x64",
				root,
			});
			assert.equal(readFileSync(binary, "utf8"), "downloaded");
			assert.equal(
				resolver.validateCachedHutch(root, "linux-x64", "linux"),
				binary,
			);
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	},
);

test("cold offline resolution performs no download or global install", async () => {
	let downloads = 0;
	let installs = 0;
	await assert.rejects(
		resolver.resolveHutchBinary({
			arch: "x64",
			cacheRoot: join(tmpdir(), `missing-electrobun-cache-${process.pid}`),
			download: async () => {
				downloads += 1;
			},
			environment: { DASH_RELEASE_OFFLINE: "yes" },
			existsSync: () => false,
			installHutch: async () => {
				installs += 1;
			},
			platform: "linux",
			userHome: "/home/dev",
		}),
		/paired Hutch is not in the npm cache.*DASH_RELEASE_OFFLINE/,
	);
	assert.equal(downloads, 0);
	assert.equal(installs, 0);
});

test("global and explicit fallbacks must prove they select the paired Hutch", async () => {
	const global = "/home/dev/.hutch/bin/hutch";
	const common = {
		arch: "x64",
		cacheRoot: join(tmpdir(), `missing-electrobun-cache-${process.pid}`),
		environment: { DASH_RELEASE_OFFLINE: "1" },
		existsSync: (candidate) => candidate === global,
		platform: "linux",
		userHome: "/home/dev",
	};
	await assert.rejects(
		resolver.resolveHutchBinary({
			...common,
			hutchBinaryVersion: () => "0.21.0",
		}),
		/before 0\.22\.0 ignore this default/,
	);
	await assert.rejects(
		resolver.resolveHutchBinary({
			...common,
			hutchBinaryVersion: () => "0.24.0",
		}),
		/must honor HUTCH_DEFAULT_CLI and select paired Hutch/,
	);
	assert.equal(
		await resolver.resolveHutchBinary({
			...common,
			hutchBinaryVersion: () => resolver.PAIRED_HUTCH_VERSION,
		}),
		global,
	);

	await assert.rejects(
		resolver.resolveHutchBinary({
			...common,
			environment: {
				DASH_RELEASE_OFFLINE: "1",
				ELECTROBUN_HUTCH_BINARY: "/custom/engine",
			},
			existsSync: () => true,
			hutchBinaryVersion: () => "0.24.0",
		}),
		/ELECTROBUN_HUTCH_BINARY.*select paired Hutch/,
	);
	assert.equal(
		await resolver.resolveHutchBinary({
			...common,
			environment: { ELECTROBUN_HUTCH_BINARY: "/custom/launcher" },
			existsSync: () => true,
			hutchBinaryVersion: () => resolver.PAIRED_HUTCH_VERSION,
		}),
		"/custom/launcher",
	);
});

test("init installs a compatible global Hutch but runs the exact cached copy", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-init-"));
	const environment = { HUTCH_HOME: join(temporary, "home") };
	const global = join(environment.HUTCH_HOME, "bin", "hutch");
	const cacheRoot = join(temporary, "cache");
	const cached = writeCachedHutch(cacheRoot);
	let globalInstalled = false;
	const calls = [];
	try {
		const status = await bootstrap.main({
			args: ["init", "my-app"],
			cacheRoot,
			environment,
			existsSync: (candidate) => candidate === global && globalInstalled,
			hutchBinaryVersion: () => resolver.PAIRED_HUTCH_VERSION,
			installHutch: async (call) => {
				calls.push({ install: call });
				globalInstalled = true;
			},
			platform: "linux",
			arch: "x64",
			runHutch: (call) => {
				calls.push({ run: call });
				return 17;
			},
			userHome: temporary,
		});
		assert.equal(status, 17);
		assert.equal(calls[0].install.channel, "production");
		assert.equal(calls[1].run.binary, cached);
		assert.deepEqual(calls[1].run.args, [
			"electrobun",
			"init",
			"my-app",
			"--channel=stable",
		]);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("supports an explicit canary global path", () => {
	assert.equal(
		resolver.hutchChannel({ ELECTROBUN_HUTCH_CHANNEL: "canary" }),
		"canary",
	);
	assert.equal(
		resolver.globalHutchBinaryPath(
			"canary",
			{ DASH_HOME: "/opt/dash" },
			"linux",
			"/home/dev",
		),
		"/opt/dash/bin/hutch-canary",
	);
});

test("an explicit ELECTROBUN_HUTCH_BINARY must exist", async () => {
	await assert.rejects(
		resolver.resolveHutchBinary({
			environment: { ELECTROBUN_HUTCH_BINARY: "/missing/hutch" },
			existsSync: () => false,
		}),
		/ELECTROBUN_HUTCH_BINARY does not exist/,
	);
});

test("the executable probes with paired defaults and preserves argv and exit status", {
	skip: process.platform === "win32",
}, () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-executable-"));
	try {
		const recorded = join(temporary, "recorded.json");
		const fakeHutch = join(temporary, "fake-hutch.cjs");
		writeFileSync(
			fakeHutch,
			[
				"#!/usr/bin/env node",
				'const { writeFileSync } = require("node:fs");',
				'if (process.argv[2] === "--version") {',
				"  process.stdout.write(process.env.HUTCH_DEFAULT_CLI || 'missing');",
				"} else {",
				"  writeFileSync(process.env.RECORDED, JSON.stringify({",
				"    args: process.argv.slice(2),",
				"    cli: process.env.HUTCH_DEFAULT_CLI,",
				"    electrobun: process.env.HUTCH_DEFAULT_ELECTROBUN,",
				"  }));",
				"  process.exitCode = 19;",
				"}",
				"",
			].join("\n"),
		);
		chmodSync(fakeHutch, 0o755);
		const result = spawnSync(
			process.execPath,
			[
				join(testRoot, "..", "bin", "electrobun.cjs"),
				"build",
				"--",
				"value with spaces",
			],
			{
				env: {
					...process.env,
					ELECTROBUN_HUTCH_BINARY: fakeHutch,
					RECORDED: recorded,
				},
				encoding: "utf8",
			},
		);
		assert.equal(result.status, 19, result.stderr);
		assert.deepEqual(JSON.parse(readFileSync(recorded, "utf8")), {
			args: ["electrobun", "build", "--", "value with spaces"],
			cli: resolver.PAIRED_HUTCH_VERSION,
			electrobun: manifest.version,
		});
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("the cold offline executable performs no HTTPS request", () => {
	const temporary = mkdtempSync(join(tmpdir(), "electrobun-npm-offline-"));
	try {
		const networkSentinel = join(temporary, "https-called");
		const blocker = join(temporary, "block-https.cjs");
		writeFileSync(
			blocker,
			[
				'const https = require("node:https");',
				'const { writeFileSync } = require("node:fs");',
				"https.get = () => {",
				'  writeFileSync(process.env.NETWORK_SENTINEL, "called");',
				'  throw new Error("unexpected HTTPS request");',
				"};",
				"",
			].join("\n"),
		);
		const result = spawnSync(
			process.execPath,
			[
				"--require",
				blocker,
				join(testRoot, "..", "bin", "electrobun.cjs"),
				"build",
			],
			{
				env: {
					...process.env,
					DASH_RELEASE_OFFLINE: "true",
					HUTCH_HOME: join(temporary, "home"),
					NETWORK_SENTINEL: networkSentinel,
				},
				encoding: "utf8",
			},
		);
		assert.equal(result.status, 1, result.stderr || result.stdout);
		assert.match(result.stderr, /npm cache.*DASH_RELEASE_OFFLINE/);
		assert.equal(existsSync(networkSentinel), false);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});
