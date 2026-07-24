import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(
	readFileSync(join(packageRoot, "runtime-artifacts.lock.json"), "utf8"),
);
const release = lock.dashCli;
const platform = (() => {
	const key = `${process.platform}-${process.arch}`;
	return {
		"darwin-arm64": "macos-arm64",
		"linux-x64": "linux-x64",
		"linux-arm64": "linux-arm64",
		"win32-x64": "windows-x64",
	}[key];
})();

if (!platform) {
	throw new Error(`Unsupported Dash CLI platform: ${process.platform}-${process.arch}`);
}

const artifact = release.platforms[platform]?.archive;
if (!artifact) throw new Error(`Dash CLI release has no ${platform} artifact`);

const extension = process.platform === "win32" ? ".exe" : "";
const dashName = `dash${extension}`;
const cottontailName = `cottontail${extension}`;
const dashDir = join(packageRoot, "vendors", "dash-cli");
const cottontailDir = join(packageRoot, "vendors", "cottontail");

function installedReleaseMatches() {
	try {
		const metadata = JSON.parse(
			readFileSync(join(dashDir, "dash-cli-release.json"), "utf8"),
		);
		const cottontailMetadataPath = existsSync(
			join(dashDir, "cottontail-release.json"),
		)
			? join(dashDir, "cottontail-release.json")
			: join(cottontailDir, "cottontail-release.json");
		const cottontailMetadata = JSON.parse(
			readFileSync(cottontailMetadataPath, "utf8"),
		);
		return (
			metadata.version === release.version &&
			metadata.revision === release.revision &&
			metadata.platform === platform &&
			metadata.cottontail?.revision === release.cottontail?.revision &&
			cottontailMetadata.revision === release.cottontail?.revision &&
			cottontailMetadata.platform === platform &&
			existsSync(join(dashDir, dashName)) &&
			existsSync(join(dashDir, cottontailName))
		);
	} catch {
		return false;
	}
}

function syncElectrobunCottontail() {
	mkdirSync(cottontailDir, { recursive: true });
	cpSync(join(dashDir, cottontailName), join(cottontailDir, cottontailName));
	const packagedMetadata = join(dashDir, "cottontail-release.json");
	const standaloneMetadata = join(cottontailDir, "cottontail-release.json");
	if (existsSync(packagedMetadata)) {
		cpSync(packagedMetadata, standaloneMetadata);
	} else if (!existsSync(standaloneMetadata)) {
		throw new Error("Cottontail release metadata is missing");
	}
	if (process.platform !== "win32") {
		chmodSync(join(cottontailDir, cottontailName), 0o755);
	}
}

if (!installedReleaseMatches()) {
	const tempRoot = mkdtempSync(join(tmpdir(), "electrobun-dash-"));
	try {
		const archivePath = join(tempRoot, basename(new URL(artifact.url).pathname));
		const response = await fetch(artifact.url);
		if (!response.ok) {
			throw new Error(`Dash CLI download failed: HTTP ${response.status}`);
		}
		const archive = Buffer.from(await response.arrayBuffer());
		const sha256 = createHash("sha256").update(archive).digest("hex");
		if (archive.byteLength !== artifact.size || sha256 !== artifact.sha256) {
			throw new Error(
				`Dash CLI archive verification failed: expected ${artifact.size} bytes/${artifact.sha256}, got ${archive.byteLength} bytes/${sha256}`,
			);
		}
		writeFileSync(archivePath, archive);

		const extractRoot = join(tempRoot, "extract");
		mkdirSync(extractRoot);
		const tar =
			process.platform === "win32"
				? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
				: "tar";
		const extracted = spawnSync(tar, ["-xzf", archivePath, "-C", extractRoot], {
			stdio: "inherit",
		});
		if (extracted.status !== 0) throw new Error("Could not extract Dash CLI archive");

		const roots = readdirSync(extractRoot, { withFileTypes: true }).filter((entry) =>
			entry.isDirectory(),
		);
		if (roots.length !== 1) throw new Error("Dash CLI archive has an unexpected layout");
		const payload = join(extractRoot, roots[0].name);
		const dashMetadata = JSON.parse(
			readFileSync(join(payload, "dash-cli-release.json"), "utf8"),
		);
		const cottontailMetadata = JSON.parse(
			readFileSync(join(payload, "cottontail-release.json"), "utf8"),
		);
		if (
			dashMetadata.revision !== release.revision ||
			dashMetadata.platform !== platform ||
			cottontailMetadata.revision !== release.cottontail?.revision ||
			cottontailMetadata.platform !== platform
		) {
			throw new Error("Dash CLI release metadata does not match the pinned release");
		}

		rmSync(dashDir, { recursive: true, force: true });
		mkdirSync(dashDir, { recursive: true });
		cpSync(join(payload, "bin", dashName), join(dashDir, dashName));
		cpSync(join(payload, "bin", cottontailName), join(dashDir, cottontailName));
		cpSync(join(payload, "dash-cli-release.json"), join(dashDir, "dash-cli-release.json"));
		cpSync(
			join(payload, "cottontail-release.json"),
			join(dashDir, "cottontail-release.json"),
		);
		if (process.platform !== "win32") {
			chmodSync(join(dashDir, dashName), 0o755);
			chmodSync(join(dashDir, cottontailName), 0o755);
		}
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

syncElectrobunCottontail();

const command =
	process.platform === "win32"
		? `.\\vendors\\dash-cli\\${dashName}`
		: `./vendors/dash-cli/${dashName}`;
console.log(`Vendored Dash CLI ${release.version}@${release.revision} (${platform})`);
console.log(`Run: ${command} run dev`);
