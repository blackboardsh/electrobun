"use strict";

// Resolve the exact Hutch release paired with this electrobun npm version.
// The single npm package stays platform-neutral: each Electrobun GitHub
// Release carries the four Hutch archives, and this shim verifies and caches
// the host archive on first use. A compatible machine-wide launcher remains
// a fallback, but Hutch before 0.22 cannot honor the paired default variables.

const { execFileSync, spawnSync } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");
const {
	accessSync,
	chmodSync,
	constants: fsConstants,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} = require("node:fs");
const { get } = require("node:https");
const { homedir, tmpdir } = require("node:os");
const path = require("node:path");

// Stamped by push-version.js from package/hutch.config.ts.
const PAIRED_HUTCH_VERSION = "0.26.0-canary.6";
const ELECTROBUN_VERSION = require("../package.json").version;

const MINIMUM_DEFAULTS_HUTCH_VERSION = "0.22.0";
const HUTCH_ARTIFACT_INDEX_FILENAME = "hutch-artifacts.json";
const HUTCH_ARTIFACT_INDEX_SCHEMA_VERSION = 1;
const CACHE_MANIFEST_FILENAME = ".electrobun-cache.json";
const CACHE_MANIFEST_SCHEMA_VERSION = 1;
const CACHE_LOCK_OWNER_FILENAME = "owner.json";
const CACHE_LOCK_RELEASED_FILENAME = "released.json";
const CACHE_LOCK_ORPHAN_FILENAME = "orphaned.json";
const defaultInstallerBaseUrl = "https://hutch.blackboard.sh/hutch";
const defaultReleasesBaseUrl =
	"https://github.com/blackboardsh/electrobun/releases/download";
const maxInstallerBytes = 1024 * 1024;
const maxArtifactIndexBytes = 1024 * 1024;
const maxArchiveBytes = 64 * 1024 * 1024;
const maxLauncherBytes = 16 * 1024 * 1024;
const maxEngineBytes = 64 * 1024 * 1024;
const maxReleaseMetadataBytes = 1024 * 1024;
const maxExtractedBytes = 80 * 1024 * 1024;
const maxRedirects = 5;
const downloadTimeoutMs = 30_000;
const hutchVersionProbeTimeoutMs = 15_000;
const cacheLockTimeoutMs = 15_000;
const cacheLockPollMs = 25;
const cacheLockOrphanGraceMs = 60_000;
const cacheRenameRetries = 4;
const cacheRenameRetryMs = 25;
const cacheLockWaiter = new Int32Array(new SharedArrayBuffer(4));
const cacheSleep = (milliseconds) =>
	Atomics.wait(cacheLockWaiter, 0, 0, milliseconds);
const strictSemver =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const releasedPlatforms = {
	"darwin-arm64": "macos-arm64",
	"linux-arm64": "linux-arm64",
	"linux-x64": "linux-x64",
	"win32-x64": "windows-x64",
};

function normalizeHutchChannel(value) {
	if (value === "stable") return "production";
	if (value === "production" || value === "canary") return value;
	return null;
}

function hutchChannel(environment) {
	for (const key of ["ELECTROBUN_HUTCH_CHANNEL", "HUTCH_ACTIVE_CHANNEL"]) {
		const selected = normalizeHutchChannel(environment[key]);
		if (selected) return selected;
	}
	return "production";
}

function environmentFlagEnabled(environment, name) {
	const value = environment[name];
	return (
		value === "1" ||
		(typeof value === "string" &&
			["true", "yes"].includes(value.toLowerCase()))
	);
}

function hutchPlatformKey(platform, arch) {
	return releasedPlatforms[`${platform}-${arch}`] ?? null;
}

function pathApiForPlatform(platform) {
	return platform === "win32" ? path.win32 : path.posix;
}

function hutchHomePath(environment, platform, userHome) {
	const pathApi = pathApiForPlatform(platform);
	return (
		environment.HUTCH_HOME ||
		environment.DASH_HOME ||
		pathApi.join(userHome, ".hutch")
	);
}

function globalHutchBinaryPath(channel, environment, platform, userHome) {
	const pathApi = pathApiForPlatform(platform);
	const command = channel === "canary" ? "hutch-canary" : "hutch";
	return pathApi.join(
		hutchHomePath(environment, platform, userHome),
		"bin",
		`${command}${platform === "win32" ? ".exe" : ""}`,
	);
}

function downloadedHutchRoot(environment, platform, userHome, platformKey) {
	const pathApi = pathApiForPlatform(platform);
	return pathApi.join(
		hutchHomePath(environment, platform, userHome),
		"npm",
		"electrobun",
		ELECTROBUN_VERSION,
		platformKey,
	);
}

function hutchBinaryInRoot(root, platform) {
	return path.join(root, "bin", platform === "win32" ? "hutch.exe" : "hutch");
}

function hutchEngineInRoot(root, platform) {
	return path.join(
		root,
		"bin",
		platform === "win32" ? "hutch-engine.exe" : "hutch-engine",
	);
}

function validatedHttpsUrl(value, label) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${label} is not a valid URL`);
	}
	const localHttp =
		url.protocol === "http:" &&
		(url.hostname === "127.0.0.1" || url.hostname === "localhost");
	if (url.protocol !== "https:" && !localHttp) {
		throw new Error(`${label} must use HTTPS`);
	}
	return url;
}

function releasesBaseUrl(environment) {
	return validatedHttpsUrl(
		environment.ELECTROBUN_RELEASES_BASE_URL ?? defaultReleasesBaseUrl,
		"Electrobun releases base URL",
	).href.replace(/\/+$/, "");
}

function download(url, options = {}, redirects = 0) {
	if (redirects > maxRedirects) {
		return Promise.reject(new Error("too many download redirects"));
	}
	let target;
	try {
		target = validatedHttpsUrl(url, options.label ?? "download URL");
	} catch (error) {
		return Promise.reject(error);
	}
	const maximum = options.maxBytes ?? maxArchiveBytes;

	return new Promise((resolve, reject) => {
		const requestGet = options.requestGet ?? get;
		const request = requestGet(target, (response) => {
			if (
				response.statusCode >= 300 &&
				response.statusCode < 400 &&
				response.headers.location
			) {
				response.resume();
				let redirected;
				try {
					redirected = new URL(response.headers.location, target);
				} catch {
					reject(new Error("invalid download redirect URL"));
					return;
				}
				resolve(download(redirected.href, options, redirects + 1));
				return;
			}

			if (response.statusCode !== 200) {
				response.resume();
				reject(
					new Error(
						`${options.label ?? "download"} returned HTTP ${response.statusCode ?? "unknown"}`,
					),
				);
				return;
			}

			const declared = Number(response.headers["content-length"]);
			if (Number.isFinite(declared) && declared > maximum) {
				response.resume();
				reject(new Error(`${options.label ?? "download"} exceeded its size limit`));
				return;
			}

			const chunks = [];
			let size = 0;
			response.on("data", (chunk) => {
				size += chunk.length;
				if (size > maximum) {
					request.destroy(
						new Error(`${options.label ?? "download"} exceeded its size limit`),
					);
					return;
				}
				chunks.push(chunk);
			});
			response.on("end", () => resolve(Buffer.concat(chunks)));
			response.on("error", reject);
		});
		request.setTimeout(downloadTimeoutMs, () => {
			request.destroy(new Error(`${options.label ?? "download"} timed out`));
		});
		request.on("error", reject);
	});
}

function checkedSpawn(command, args, options) {
	const result = spawnSync(command, args, options);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
	}
}

async function installHutch({ channel, environment, platform }) {
	const temporary = mkdtempSync(path.join(tmpdir(), "electrobun-hutch-installer-"));
	try {
		if (platform === "win32") {
			const installer = path.join(temporary, "install.ps1");
			writeFileSync(
				installer,
				await download(`${defaultInstallerBaseUrl}/install.ps1`, {
					label: "Hutch installer",
					maxBytes: maxInstallerBytes,
				}),
			);
			checkedSpawn(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					installer,
					"-Channel",
					channel,
				],
				{ env: environment, stdio: "inherit" },
			);
		} else {
			const installer = path.join(temporary, "install.sh");
			writeFileSync(
				installer,
				await download(`${defaultInstallerBaseUrl}/install.sh`, {
					label: "Hutch installer",
					maxBytes: maxInstallerBytes,
				}),
				{ mode: 0o700 },
			);
			checkedSpawn("sh", [installer, "--channel", channel], {
				env: environment,
				stdio: "inherit",
			});
		}
	} finally {
		rmSync(temporary, { force: true, recursive: true });
	}
}

function parseVersion(value) {
	const match = typeof value === "string" ? value.match(strictSemver) : null;
	if (!match) return null;
	return {
		core: [Number(match[1]), Number(match[2]), Number(match[3])],
		prerelease: match[4] ?? null,
		version: value,
	};
}

function hutchBinaryVersion(
	binary,
	environment,
	spawn = spawnSync,
	sharedTemporaryDirectory = tmpdir(),
) {
	// Hutch discovers hutch.config.* through cwd ancestors. Running from the
	// shared temp directory can therefore inherit an unrelated /tmp config;
	// the filesystem root is outside that project-discovery subtree.
	const neutralCwd = path.parse(path.resolve(sharedTemporaryDirectory)).root;
	const result = spawn(binary, ["--version"], {
		cwd: neutralCwd,
		encoding: "utf8",
		env: {
			...environment,
			HUTCH_DEFAULT_CLI: PAIRED_HUTCH_VERSION,
			HUTCH_DEFAULT_ELECTROBUN: ELECTROBUN_VERSION,
			PWD: neutralCwd,
		},
		timeout: hutchVersionProbeTimeoutMs,
		windowsHide: true,
	});
	if (result.error || result.status !== 0) return null;
	const version = result.stdout?.trim();
	return parseVersion(version) ? version : null;
}

function compatibleFallback(binary, environment, versionReader = hutchBinaryVersion) {
	const version = versionReader(binary, environment);
	return {
		binary,
		compatible: version === PAIRED_HUTCH_VERSION,
		version,
	};
}

function incompatibleFallbackError(label, fallback) {
	const found = fallback.version
		? `selected Hutch ${fallback.version}`
		: "could not select a Hutch release";
	return new Error(
		`${label} ${found}; it must honor HUTCH_DEFAULT_CLI and select paired Hutch ${PAIRED_HUTCH_VERSION} (launchers before ${MINIMUM_DEFAULTS_HUTCH_VERSION} ignore this default)`,
	);
}

function object(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value;
}

function validateArtifactIndex(bytes, baseUrl, platformKey) {
	let index;
	try {
		index = JSON.parse(bytes.toString("utf8"));
	} catch (error) {
		throw new Error(`Hutch artifact index is invalid JSON: ${error.message}`);
	}
	object(index, "Hutch artifact index");
	if (index.schemaVersion !== HUTCH_ARTIFACT_INDEX_SCHEMA_VERSION) {
		throw new Error("unsupported Hutch artifact index schema");
	}
	const product = object(index.product, "Hutch artifact index product");
	if (product.name !== "electrobun" || product.version !== ELECTROBUN_VERSION) {
		throw new Error("Hutch artifact index Electrobun identity does not match");
	}
	const hutch = object(index.hutch, "Hutch artifact index release");
	if (hutch.version !== PAIRED_HUTCH_VERSION) {
		throw new Error("Hutch artifact index paired version does not match");
	}
	const platforms = object(index.platforms, "Hutch artifact index platforms");
	const expectedPlatforms = [...new Set(Object.values(releasedPlatforms))].sort();
	if (JSON.stringify(Object.keys(platforms).sort()) !== JSON.stringify(expectedPlatforms)) {
		throw new Error("Hutch artifact index platform matrix is incomplete");
	}
	const archive = object(
		object(platforms[platformKey], `${platformKey} artifact`).archive,
		`${platformKey} archive`,
	);
	const filename = `electrobun-hutch-${platformKey}.tar.gz`;
	const expectedUrl = `${baseUrl}/v${ELECTROBUN_VERSION}/${filename}`;
	if (archive.url !== expectedUrl) {
		throw new Error(`${platformKey} archive URL does not match the Electrobun release`);
	}
	if (!Number.isSafeInteger(archive.size) || archive.size < 1 || archive.size > maxArchiveBytes) {
		throw new Error(`${platformKey} archive size is invalid`);
	}
	if (!/^[0-9a-f]{64}$/.test(archive.sha256)) {
		throw new Error(`${platformKey} archive SHA-256 is invalid`);
	}
	return { filename, ...archive };
}

function expectedArchiveEntries(
	platformKey,
	platform,
	expectedHutchVersion = PAIRED_HUTCH_VERSION,
) {
	const root = `hutch-v${expectedHutchVersion}-${platformKey}`;
	const extension = platform === "win32" ? ".exe" : "";
	const memberLimits = new Map([
		[`${root}/bin/hutch${extension}`, maxLauncherBytes],
		[`${root}/bin/hutch-engine${extension}`, maxEngineBytes],
		[`${root}/hutch-release.json`, maxReleaseMetadataBytes],
	]);
	return {
		files: new Set(memberLimits.keys()),
		memberLimits,
		root,
	};
}

function validateArchiveEntries(
	archivePath,
	platformKey,
	platform,
	environment,
	execute = execFileSync,
	expectedHutchVersion = PAIRED_HUTCH_VERSION,
	tarExecutable,
) {
	const tar = tarExecutable ?? tarCommand(platform, environment);
	const archiveDirectory = path.dirname(archivePath);
	const archiveFilename = path.basename(archivePath);
	// Windows bsdtar can corrupt non-ACP absolute argv paths. Node passes cwd
	// through the native wide-character API, so keep every tar argv path ASCII.
	const listing = execute(tar, ["-tzf", archiveFilename], {
		cwd: archiveDirectory,
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
	});
	const verbose = execute(tar, ["-tvzf", archiveFilename], {
		cwd: archiveDirectory,
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
	});
	const names = listing.trim().split(/\r?\n/).filter(Boolean);
	const details = verbose.trim().split(/\r?\n/).filter(Boolean);
	if (names.length !== details.length) {
		throw new Error("Hutch archive listing is inconsistent");
	}
	const expected = expectedArchiveEntries(
		platformKey,
		platform,
		expectedHutchVersion,
	);
	const seenFiles = new Set();
	for (let index = 0; index < names.length; index += 1) {
		const raw = names[index];
		if (raw.includes("\\") || raw.includes("\0") || path.posix.isAbsolute(raw)) {
			throw new Error("Hutch archive contains an unsafe path");
		}
		const name = path.posix.normalize(raw.replace(/\/+$/, ""));
		if (
			name === ".." ||
			name.startsWith("../") ||
			(name !== expected.root && !name.startsWith(`${expected.root}/`))
		) {
			throw new Error("Hutch archive contains an unsafe path");
		}
		const type = details[index][0];
		if (expected.files.has(name)) {
			if (type !== "-") throw new Error("Hutch archive executable is not a regular file");
			if (seenFiles.has(name)) throw new Error("Hutch archive contains duplicate files");
			seenFiles.add(name);
		} else if (
			(name === expected.root || name === `${expected.root}/bin`) &&
			type === "d"
		) {
			continue;
		} else {
			throw new Error(`Hutch archive contains an unexpected entry: ${raw}`);
		}
	}
	if (seenFiles.size !== expected.files.size) {
		throw new Error("Hutch archive is missing required files");
	}

	// Avoid locale-dependent parsing of `tar -tv` sizes. Ask tar to stream each
	// already allowlisted regular member to stdout under a strict maxBuffer;
	// extraction can therefore never write an unbounded decompression bomb.
	let extractedBytes = 0;
	for (const [member, maximum] of expected.memberLimits) {
		let contents;
		try {
			contents = execute(tar, ["-xOzf", archiveFilename, member], {
				cwd: archiveDirectory,
				encoding: null,
				maxBuffer: maximum,
			});
		} catch (error) {
			throw new Error(
				`Hutch archive member ${member} is unreadable or exceeds its size limit: ${error.message}`,
			);
		}
		const size = Buffer.isBuffer(contents)
			? contents.length
			: Buffer.byteLength(contents ?? "");
		if (size < 1 || size > maximum) {
			throw new Error(`Hutch archive member ${member} exceeds its size limit`);
		}
		extractedBytes += size;
		if (extractedBytes > maxExtractedBytes) {
			throw new Error("Hutch archive exceeds its total extracted-size limit");
		}
	}
	return expected.root;
}

function cacheMemberLimits(platform) {
	const extension = platform === "win32" ? ".exe" : "";
	return new Map([
		[`bin/hutch${extension}`, maxLauncherBytes],
		[`bin/hutch-engine${extension}`, maxEngineBytes],
		["hutch-release.json", maxReleaseMetadataBytes],
	]);
}

function sha256File(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function pathEntryExists(file) {
	try {
		lstatSync(file);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

function writeCacheManifest(
	root,
	platformKey,
	platform,
	expectedHutchVersion,
	archive,
) {
	const files = {};
	for (const [relative, maximum] of cacheMemberLimits(platform)) {
		const file = path.join(root, ...relative.split("/"));
		const stat = lstatSync(file);
		if (!stat.isFile() || stat.size < 1 || stat.size > maximum) {
			throw new Error(`extracted Hutch cache member ${relative} is invalid`);
		}
		files[relative] = {
			size: stat.size,
			sha256: sha256File(file),
			...(platform !== "win32" && relative.startsWith("bin/")
				? { mode: stat.mode & 0o777 }
				: {}),
		};
	}
	writeFileSync(
		path.join(root, CACHE_MANIFEST_FILENAME),
		`${JSON.stringify({
			schemaVersion: CACHE_MANIFEST_SCHEMA_VERSION,
			electrobunVersion: ELECTROBUN_VERSION,
			hutchVersion: expectedHutchVersion,
			platform: platformKey,
			archiveSha256: createHash("sha256").update(archive).digest("hex"),
			files,
		})}\n`,
		{ flag: "wx", mode: 0o444 },
	);
}

function validateCachedHutch(
	root,
	platformKey,
	platform,
	expectedHutchVersion = PAIRED_HUTCH_VERSION,
	requireCacheManifest = true,
) {
	try {
		const members = cacheMemberLimits(platform);
		const memberPaths = new Map(
			[...members.keys()].map((relative) => [
				relative,
				path.join(root, ...relative.split("/")),
			]),
		);
		const metadataPath = memberPaths.get("hutch-release.json");
		const binary = hutchBinaryInRoot(root, platform);
		const engine = hutchEngineInRoot(root, platform);
		const realRoot = realpathSync(root);
		for (const [relative, candidate] of memberPaths) {
			const stat = lstatSync(candidate);
			const maximum = members.get(relative);
			if (!stat.isFile() || stat.size < 1 || stat.size > maximum) return null;
			const resolved = realpathSync(candidate);
			if (!resolved.startsWith(`${realRoot}${path.sep}`)) return null;
		}
		const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
		const extension = platform === "win32" ? ".exe" : "";
		if (
			metadata.schema !== 1 ||
			metadata.kind !== "archive" ||
			metadata.product !== "hutch" ||
			metadata.version !== expectedHutchVersion ||
			metadata.platform !== platformKey ||
			metadata.launcher !== `bin/hutch${extension}` ||
			metadata.executable !== `bin/hutch-engine${extension}`
		) {
			return null;
		}
		if (!requireCacheManifest) return binary;

		if (platform !== "win32") {
			for (const executable of [binary, engine]) {
				try {
					accessSync(executable, fsConstants.X_OK);
				} catch {
					return null;
				}
			}
		}
		const manifestPath = path.join(root, CACHE_MANIFEST_FILENAME);
		const manifestStat = lstatSync(manifestPath);
		if (
			!manifestStat.isFile() ||
			manifestStat.size < 1 ||
			manifestStat.size > maxReleaseMetadataBytes ||
				(platform !== "win32" && (manifestStat.mode & 0o022) !== 0)
		) {
			return null;
		}
		const resolvedManifest = realpathSync(manifestPath);
		if (!resolvedManifest.startsWith(`${realRoot}${path.sep}`)) return null;
		const cache = object(
			JSON.parse(readFileSync(manifestPath, "utf8")),
			"Hutch cache manifest",
		);
		if (
			cache.schemaVersion !== CACHE_MANIFEST_SCHEMA_VERSION ||
			cache.electrobunVersion !== ELECTROBUN_VERSION ||
			cache.hutchVersion !== expectedHutchVersion ||
			cache.platform !== platformKey ||
			!/^[0-9a-f]{64}$/.test(cache.archiveSha256)
		) {
			return null;
		}
		const cachedFiles = object(cache.files, "Hutch cache manifest files");
		const expectedFiles = [...members.keys()].sort();
		if (
			JSON.stringify(Object.keys(cachedFiles).sort()) !==
			JSON.stringify(expectedFiles)
		) {
			return null;
		}
		for (const relative of expectedFiles) {
			const descriptor = object(
				cachedFiles[relative],
				`Hutch cache member ${relative}`,
			);
			const file = memberPaths.get(relative);
			const stat = lstatSync(file);
			const executableModeIsValid =
				platform === "win32" ||
				!relative.startsWith("bin/") ||
				(Number.isSafeInteger(descriptor.mode) &&
					descriptor.mode >= 0 &&
					descriptor.mode <= 0o777 &&
					(descriptor.mode & 0o022) === 0 &&
					(stat.mode & 0o777) === descriptor.mode);
			if (
				descriptor.size !== stat.size ||
				!/^[0-9a-f]{64}$/.test(descriptor.sha256) ||
				descriptor.sha256 !== sha256File(file) ||
				!executableModeIsValid
			) {
				return null;
			}
		}
		return binary;
	} catch {
		return null;
	}
}

function tarCommand(platform, environment) {
	return platform === "win32"
		? path.win32.join(environment.SystemRoot || "C:\\Windows", "System32", "tar.exe")
		: "tar";
}

function readCacheLockRecord(lock, filename) {
	try {
		const record = object(
			JSON.parse(readFileSync(path.join(lock, filename), "utf8")),
			"Hutch cache lock record",
		);
		if (
			record.schemaVersion !== 1 ||
			!Number.isSafeInteger(record.pid) ||
			record.pid < 1 ||
			!Number.isSafeInteger(record.createdAt) ||
			record.createdAt < 0 ||
			typeof record.token !== "string" ||
			!/^[0-9a-f]{32}$/.test(record.token)
		) {
			return null;
		}
		return record;
	} catch {
		return null;
	}
}

function processIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code !== "ESRCH";
	}
}

function reclaimableCacheLock(lock, now, isProcessAlive) {
	let stat;
	try {
		stat = lstatSync(lock);
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
	const owner = readCacheLockRecord(lock, CACHE_LOCK_OWNER_FILENAME);
	if (owner) {
		const released = readCacheLockRecord(lock, CACHE_LOCK_RELEASED_FILENAME);
		if (released?.token === owner.token) {
			return { kind: "owner", token: owner.token };
		}
		if (!isProcessAlive(owner.pid)) {
			return { kind: "owner", token: owner.token };
		}
		return null;
	}
	const recordedOrphan = readCacheLockRecord(lock, CACHE_LOCK_ORPHAN_FILENAME);
	if (recordedOrphan) {
		return { kind: "orphan", token: recordedOrphan.token };
	}
	if (now() - stat.mtimeMs < cacheLockOrphanGraceMs) return null;
	const orphanFingerprint = () => ({
		kind: "orphan",
		token: createHash("sha256")
			.update(`${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`)
			.digest("hex")
			.slice(0, 32),
	});
	if (pathEntryExists(path.join(lock, CACHE_LOCK_ORPHAN_FILENAME))) {
		// A crash can leave a partial marker. The old directory is already
		// non-empty, so a stat-derived deterministic token still provides the same
		// ABA fence as a valid marker without deleting or replacing it in place.
		return orphanFingerprint();
	}
	const orphan = {
		schemaVersion: 1,
		pid: process.pid,
		createdAt: now(),
		token: randomBytes(16).toString("hex"),
	};
	try {
		writeFileSync(
			path.join(lock, CACHE_LOCK_ORPHAN_FILENAME),
			`${JSON.stringify(orphan)}\n`,
			{ flag: "wx", mode: 0o444 },
		);
	} catch (error) {
		if (error.code !== "EEXIST") {
			if (error.code === "ENOENT") return null;
			throw error;
		}
	}
	// A legitimate creator that was paused between mkdir and owner publication
	// always wins over the orphan marker.
	const lateOwner = readCacheLockRecord(lock, CACHE_LOCK_OWNER_FILENAME);
	if (lateOwner) {
		if (!isProcessAlive(lateOwner.pid)) {
			return { kind: "owner", token: lateOwner.token };
		}
		return null;
	}
	const marked = readCacheLockRecord(lock, CACHE_LOCK_ORPHAN_FILENAME);
	return marked ? { kind: "orphan", token: marked.token } : orphanFingerprint();
}

function sameReclaimCandidate(left, right) {
	if (!left || !right || left.kind !== right.kind) return false;
	return left.token === right.token;
}

function tryReclaimCacheLock({
	candidate,
	isProcessAlive,
	lock,
	now,
	rename,
}) {
	// Re-read immediately before the atomic move. In particular, never reclaim
	// a lock whose recorded owner is still alive, regardless of its age.
	if (
		!sameReclaimCandidate(
			candidate,
			reclaimableCacheLock(lock, now, isProcessAlive),
		)
	) {
		return false;
	}
	// The candidate-stable tombstone is intentionally retained. It is a fence:
	// every waiter that previously observed this stale token renames to the same
	// non-empty destination, so only one can win and no delayed waiter can move a
	// replacement owner's fixed lock (the classic reclaim ABA race).
	const tombstone = `${lock}.reclaimed-${candidate.token}`;
	try {
		mkdirSync(tombstone);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	const quarantine = path.join(tombstone, "stale-lock");
	try {
		rename(lock, quarantine);
	} catch (error) {
		if (["EEXIST", "ENOENT", "ENOTEMPTY"].includes(error.code)) return false;
		if (error.code === "EPERM" && pathEntryExists(quarantine)) return false;
		if (["EACCES", "EBUSY", "EPERM"].includes(error.code)) return false;
		throw error;
	}
	return true;
}

function acquireCacheLock({
	expectedHutchVersion,
	isProcessAlive = processIsAlive,
	makeDirectory = mkdirSync,
	now = Date.now,
	platform,
	platformKey,
	remove = rmSync,
	rename = renameSync,
	root,
	sleep = cacheSleep,
	timeoutMs = cacheLockTimeoutMs,
}) {
	const lock = `${root}.install-lock`;
	const deadline = now() + timeoutMs;
	const owner = {
		schemaVersion: 1,
		pid: process.pid,
		createdAt: now(),
		token: randomBytes(16).toString("hex"),
	};
	const claim = `${lock}.claim-${process.pid}-${owner.token}`;
	makeDirectory(claim);
	try {
		writeFileSync(
			path.join(claim, CACHE_LOCK_OWNER_FILENAME),
			`${JSON.stringify(owner)}\n`,
			{ flag: "wx", mode: 0o444 },
		);
	} catch (error) {
		remove(claim, { force: true, recursive: true });
		throw error;
	}

	try {
		while (true) {
			if (!pathEntryExists(lock)) {
				try {
					rename(claim, lock);
					break;
				} catch (error) {
					if (!pathEntryExists(lock)) {
						if (
							["EACCES", "EBUSY", "EEXIST", "ENOTEMPTY", "EPERM"].includes(
								error.code,
							)
						) {
							// A competing owner may publish and release entirely before this
							// catch runs. The prepared claim is still ours, so retry it.
							if (now() >= deadline) {
								throw new Error(`timed out waiting for Hutch cache lock ${lock}`);
							}
							sleep(cacheLockPollMs);
							continue;
						}
						throw error;
					}
				}
			}
			const candidate = reclaimableCacheLock(lock, now, isProcessAlive);
			if (
				candidate &&
				tryReclaimCacheLock({
					candidate,
					isProcessAlive,
					lock,
					now,
					rename,
				})
			) {
				continue;
			}
			if (now() >= deadline) {
				throw new Error(`timed out waiting for Hutch cache lock ${lock}`);
			}
			sleep(cacheLockPollMs);
		}
	} catch (error) {
		remove(claim, { force: true, recursive: true });
		throw error;
	}

	let released = false;
	return {
		cached: null,
		release() {
			if (released) return;
			released = true;
			const current = readCacheLockRecord(lock, CACHE_LOCK_OWNER_FILENAME);
			if (current?.token !== owner.token) return;
			const quarantine = `${lock}.released-${owner.token}`;
			try {
				rename(lock, quarantine);
			} catch {
				// Never delete the fixed path after a failed move: it may already name a
				// replacement owner. Mark only our still-current token as released.
				const unchanged = readCacheLockRecord(lock, CACHE_LOCK_OWNER_FILENAME);
				if (unchanged?.token === owner.token) {
					try {
						writeFileSync(
							path.join(lock, CACHE_LOCK_RELEASED_FILENAME),
							`${JSON.stringify(owner)}\n`,
							{ flag: "wx", mode: 0o444 },
						);
					} catch {
						// A later waiter can retry once the owner exits.
					}
				}
				return;
			}
			try {
				remove(quarantine, { force: true, recursive: true });
			} catch {
				// The fixed path is already free; this owner-unique path is harmless.
			}
		},
	};
}

function installDownloadedArchive({
	archive,
	cacheLock = acquireCacheLock,
	cleanup = rmSync,
	environment,
	execute = execFileSync,
	expectedHutchVersion = PAIRED_HUTCH_VERSION,
	makeLockDirectory = mkdirSync,
	platform,
	platformKey,
	rename = renameSync,
	remove = rmSync,
	root,
	sleep = cacheSleep,
	tarExecutable,
}) {
	const parent = path.dirname(root);
	mkdirSync(parent, { recursive: true });
	const temporary = mkdtempSync(path.join(parent, `.install-${platformKey}-`));
	try {
		const archivePath = path.join(temporary, "hutch.tar.gz");
		writeFileSync(archivePath, archive, { flag: "wx" });
		const extractedName = validateArchiveEntries(
			archivePath,
			platformKey,
			platform,
			environment,
			execute,
			expectedHutchVersion,
			tarExecutable,
		);
		execute(tarExecutable ?? tarCommand(platform, environment), ["-xzf", "hutch.tar.gz"], {
			cwd: temporary,
			stdio: "pipe",
		});
		const extracted = path.join(temporary, extractedName);
		let binary = validateCachedHutch(
			extracted,
			platformKey,
			platform,
			expectedHutchVersion,
			false,
		);
		if (!binary) throw new Error("extracted Hutch archive identity is invalid");
		if (platform !== "win32") {
			chmodSync(binary, 0o755);
			chmodSync(hutchEngineInRoot(extracted, platform), 0o755);
		}
		writeCacheManifest(
			extracted,
			platformKey,
			platform,
			expectedHutchVersion,
			archive,
		);
		binary = validateCachedHutch(
			extracted,
			platformKey,
			platform,
			expectedHutchVersion,
		);
		if (!binary) throw new Error("sealed Hutch cache is invalid");

		const lock = cacheLock({
			expectedHutchVersion,
			makeDirectory: makeLockDirectory,
			platform,
			platformKey,
			remove,
			rename,
			root,
		});
		if (lock.cached) return lock.cached;
		let quarantine = null;
		let publishedExtracted = false;
		let committed = false;
		try {
			const existing = validateCachedHutch(
				root,
				platformKey,
				platform,
				expectedHutchVersion,
			);
			if (existing) return existing;

			if (pathEntryExists(root)) {
				// This second validation happens while holding the per-root lock and
				// immediately before quarantine, so a valid winner is never moved.
				const beforeQuarantine = validateCachedHutch(
					root,
					platformKey,
					platform,
					expectedHutchVersion,
				);
				if (beforeQuarantine) return beforeQuarantine;
				const invalidQuarantine = `${root}.invalid-${process.pid}-${randomBytes(8).toString("hex")}`;
				for (let attempt = 0; attempt <= cacheRenameRetries; attempt += 1) {
					const validNow = validateCachedHutch(
						root,
						platformKey,
						platform,
						expectedHutchVersion,
					);
					if (validNow) return validNow;
					try {
						rename(root, invalidQuarantine);
						quarantine = invalidQuarantine;
						break;
					} catch (error) {
						const recovered = validateCachedHutch(
							root,
							platformKey,
							platform,
							expectedHutchVersion,
						);
						if (recovered) return recovered;
						if (error.code === "ENOENT" && !pathEntryExists(root)) break;
						if (
							["EACCES", "EBUSY", "EPERM"].includes(error.code) &&
							attempt < cacheRenameRetries
						) {
							sleep(cacheRenameRetryMs);
							continue;
						}
						throw error;
					}
				}
			}

			let raced = null;
			for (let attempt = 0; attempt <= cacheRenameRetries; attempt += 1) {
				try {
					rename(extracted, root);
					publishedExtracted = true;
					break;
				} catch (error) {
					raced = validateCachedHutch(
						root,
						platformKey,
						platform,
						expectedHutchVersion,
					);
					if (raced) break;
					if (
						["EACCES", "EBUSY", "EPERM"].includes(error.code) &&
						attempt < cacheRenameRetries
					) {
						sleep(cacheRenameRetryMs);
						continue;
					}
					throw error;
				}
			}
			if (raced) {
				committed = true;
				if (quarantine) {
					try {
						remove(quarantine, { force: true, recursive: true });
					} catch {
						// The valid winner is committed; quarantine cleanup is best-effort.
					}
					quarantine = null;
				}
				return raced;
			}
			const installed = validateCachedHutch(
				root,
				platformKey,
				platform,
				expectedHutchVersion,
			);
			if (!installed) throw new Error("installed Hutch cache is invalid");
			// From this point the cache is a complete immutable unit. Other resolver
			// processes may observe it, so later cleanup must never roll it back.
			committed = true;
			if (quarantine) {
				try {
					remove(quarantine, { force: true, recursive: true });
				} catch {
					// Cache publication succeeded; an invalid quarantine is best-effort.
				}
				quarantine = null;
			}
			return installed;
		} catch (error) {
			if (publishedExtracted && !committed) {
				remove(root, { force: true, recursive: true });
			}
			if (quarantine) {
				remove(quarantine, { force: true, recursive: true });
			}
			throw error;
		} finally {
			lock.release();
		}
	} finally {
		try {
			cleanup(temporary, {
				force: true,
				maxRetries: cacheRenameRetries,
				recursive: true,
				retryDelay: cacheRenameRetryMs,
			});
		} catch {
			// A committed cache must never be reported as failed because Windows AV
			// temporarily holds the private extraction directory. Old temp cleanup is
			// deliberately a separate, lower-priority maintenance concern.
		}
	}
}

async function downloadPairedHutch(options) {
	const baseUrl = releasesBaseUrl(options.environment);
	const releaseUrl = `${baseUrl}/v${ELECTROBUN_VERSION}`;
	const fetchBytes = options.download ?? download;
	const index = await fetchBytes(`${releaseUrl}/${HUTCH_ARTIFACT_INDEX_FILENAME}`, {
		label: "Hutch artifact index",
		maxBytes: maxArtifactIndexBytes,
	});
	const descriptor = validateArtifactIndex(index, baseUrl, options.platformKey);
	console.error(
		`Downloading Hutch ${PAIRED_HUTCH_VERSION} for Electrobun ${ELECTROBUN_VERSION} (${options.platformKey})...`,
	);
	const archive = await fetchBytes(descriptor.url, {
		label: `${options.platformKey} Hutch archive`,
		maxBytes: maxArchiveBytes,
	});
	if (archive.length !== descriptor.size) {
		throw new Error(
			`downloaded Hutch archive size ${archive.length} does not match ${descriptor.size}`,
		);
	}
	const digest = createHash("sha256").update(archive).digest("hex");
	if (digest !== descriptor.sha256) {
		throw new Error("downloaded Hutch archive SHA-256 does not match the release index");
	}
	return installDownloadedArchive({
		...options,
		archive,
		expectedHutchVersion: PAIRED_HUTCH_VERSION,
	});
}

async function ensureCompatibleGlobal(options) {
	const channel = hutchChannel(options.environment);
	const global = globalHutchBinaryPath(
		channel,
		options.environment,
		options.platform,
		options.userHome,
	);
	const versionReader = options.hutchBinaryVersion ?? hutchBinaryVersion;
	if (options.fileExists(global)) {
		const existing = compatibleFallback(global, options.environment, versionReader);
		if (existing.compatible) return global;
		if (environmentFlagEnabled(options.environment, "DASH_RELEASE_OFFLINE")) {
			throw incompatibleFallbackError("the installed global Hutch", existing);
		}
	}
	if (environmentFlagEnabled(options.environment, "DASH_RELEASE_OFFLINE")) {
		throw new Error(
			`Hutch is not installed at ${global}; DASH_RELEASE_OFFLINE prevents downloading it`,
		);
	}
	console.error(
		`Electrobun projects use Hutch; installing the latest ${channel} release...`,
	);
	await options.install({
		channel,
		environment: options.environment,
		platform: options.platform,
	});
	if (!options.fileExists(global)) throw new Error(`Hutch was not installed at ${global}`);
	const installed = compatibleFallback(global, options.environment, versionReader);
	if (!installed.compatible) {
		throw incompatibleFallbackError("the installed global Hutch", installed);
	}
	return global;
}

async function resolveHutchBinary(options = {}) {
	const environment = options.environment ?? process.env;
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const userHome = options.userHome ?? homedir();
	const fileExists = options.existsSync ?? existsSync;
	const install = options.installHutch ?? installHutch;
	const versionReader = options.hutchBinaryVersion ?? hutchBinaryVersion;
	const common = {
		...options,
		environment,
		fileExists,
		install,
		platform,
		userHome,
	};

	if (environment.ELECTROBUN_HUTCH_BINARY) {
		const configured = environment.ELECTROBUN_HUTCH_BINARY;
		if (!fileExists(configured)) {
			throw new Error(`ELECTROBUN_HUTCH_BINARY does not exist: ${configured}`);
		}
		const explicit = compatibleFallback(configured, environment, versionReader);
		if (!explicit.compatible) {
			throw incompatibleFallbackError("ELECTROBUN_HUTCH_BINARY", explicit);
		}
		return configured;
	}

	if (options.ensureGlobalHutch) await ensureCompatibleGlobal(common);

	const platformKey = hutchPlatformKey(platform, arch);
	if (platformKey) {
		const root =
			options.cacheRoot ??
			downloadedHutchRoot(environment, platform, userHome, platformKey);
		const cached = validateCachedHutch(root, platformKey, platform);
		if (cached) return cached;

		if (!environmentFlagEnabled(environment, "DASH_RELEASE_OFFLINE")) {
			try {
				return await downloadPairedHutch({
					...common,
					platformKey,
					root,
				});
			} catch (error) {
				common.assetError = error;
			}
		}
	}

	const channel = hutchChannel(environment);
	const global = globalHutchBinaryPath(channel, environment, platform, userHome);
	if (fileExists(global)) {
		const fallback = compatibleFallback(global, environment, versionReader);
		if (fallback.compatible) {
			if (common.assetError) {
				console.error(
					`Electrobun could not acquire its paired Hutch asset (${common.assetError.message}); using compatible global Hutch ${fallback.version}.`,
				);
			}
			return global;
		}
		if (environmentFlagEnabled(environment, "DASH_RELEASE_OFFLINE")) {
			throw incompatibleFallbackError("the installed global Hutch", fallback);
		}
	}

	if (environmentFlagEnabled(environment, "DASH_RELEASE_OFFLINE")) {
		const cache = platformKey ? "paired Hutch is not in the npm cache" : "platform is unsupported";
		throw new Error(`${cache}; DASH_RELEASE_OFFLINE prevents downloading it`);
	}

	try {
		return await ensureCompatibleGlobal(common);
	} catch (fallbackError) {
		if (common.assetError) {
			throw new Error(
				`could not acquire paired Hutch: ${common.assetError.message}; global fallback failed: ${fallbackError.message}`,
			);
		}
		throw fallbackError;
	}
}

function environmentWithPairedDefaults(environment) {
	const enriched = { ...environment };
	if (!enriched.HUTCH_DEFAULT_CLI) {
		enriched.HUTCH_DEFAULT_CLI = PAIRED_HUTCH_VERSION;
	}
	if (!enriched.HUTCH_DEFAULT_ELECTROBUN) {
		enriched.HUTCH_DEFAULT_ELECTROBUN = ELECTROBUN_VERSION;
	}
	return enriched;
}

function runHutch({ binary, args, environment }) {
	const result = spawnSync(binary, args, {
		env: environmentWithPairedDefaults(environment),
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== null) return result.status;
	if (result.signal === "SIGINT") return 130;
	if (result.signal === "SIGTERM") return 143;
	return 1;
}

module.exports = {
	CACHE_MANIFEST_FILENAME,
	CACHE_LOCK_OWNER_FILENAME,
	ELECTROBUN_VERSION,
	HUTCH_ARTIFACT_INDEX_FILENAME,
	MINIMUM_DEFAULTS_HUTCH_VERSION,
	PAIRED_HUTCH_VERSION,
	acquireCacheLock,
	download,
	downloadedHutchRoot,
	environmentWithPairedDefaults,
	globalHutchBinaryPath,
	hutchChannel,
	hutchBinaryVersion,
	hutchPlatformKey,
	installDownloadedArchive,
	resolveHutchBinary,
	runHutch,
	validateArtifactIndex,
	validateCachedHutch,
};
