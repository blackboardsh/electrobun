// Builds the @electrobun/hutch-<os>-<cpu> platform packages from the pinned
// Hutch release's published archives. Each package vendors the Hutch
// launcher and engine for one platform, so `npm install electrobun` fully
// provisions the toolchain with no postinstall and no global mutation.
//
// The pinned Hutch version is the shim's stamped PAIRED_HUTCH_VERSION — the
// same value release provenance requires to match the repository pragma.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const npmRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bootstrapRoot = join(npmRoot, "electrobun");
const outputRoot = join(npmRoot, "platform-packages");
const manifestBaseUrl =
	process.env.HUTCH_ARTIFACTS_BASE_URL ?? "https://hutch.blackboard.sh";

const hutchPlatforms = {
	"macos-arm64": { os: "darwin", cpu: "arm64" },
	"linux-x64": { os: "linux", cpu: "x64" },
	"linux-arm64": { os: "linux", cpu: "arm64" },
	"windows-x64": { os: "win32", cpu: "x64" },
};

function fail(message) {
	console.error(`build-platform-packages: ${message}`);
	process.exit(1);
}

function stampedConstant(source, name) {
	const match = source.match(
		new RegExp(`const ${name} = "([0-9A-Za-z.\\-]+)";`),
	);
	if (!match) fail(`could not read ${name} from resolve-hutch.cjs`);
	return match[1];
}

const shimSource = readFileSync(
	join(bootstrapRoot, "bin", "resolve-hutch.cjs"),
	"utf8",
);
const hutchVersion = stampedConstant(shimSource, "PAIRED_HUTCH_VERSION");
const bootstrap = JSON.parse(
	readFileSync(join(bootstrapRoot, "package.json"), "utf8"),
);
const packageVersion = bootstrap.version;

const expectedNames = Object.values(hutchPlatforms).map(
	({ os, cpu }) => `@electrobun/hutch-${os}-${cpu}`,
);
const declared = Object.keys(bootstrap.optionalDependencies ?? {}).sort();
if (JSON.stringify(declared) !== JSON.stringify([...expectedNames].sort())) {
	fail(
		`optionalDependencies (${declared.join(", ")}) do not match the built platform set`,
	);
}
for (const name of expectedNames) {
	if (bootstrap.optionalDependencies[name] !== packageVersion) {
		fail(`${name} must be pinned to ${packageVersion}`);
	}
}

async function fetchBytes(url) {
	const response = await fetch(url);
	if (!response.ok) fail(`HTTP ${response.status} for ${url}`);
	return Buffer.from(await response.arrayBuffer());
}

const manifestUrl = `${manifestBaseUrl}/hutch/releases/${hutchVersion}/manifest.json`;
const manifest = JSON.parse((await fetchBytes(manifestUrl)).toString("utf8"));
if (manifest.version !== hutchVersion) {
	fail(`manifest version ${manifest.version} != pinned ${hutchVersion}`);
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

for (const [hutchPlatform, { os, cpu }] of Object.entries(hutchPlatforms)) {
	const entry = manifest.platforms?.[hutchPlatform];
	if (!entry) fail(`manifest has no platform ${hutchPlatform}`);
	const archive = await fetchBytes(entry.archive.url);
	const digest = createHash("sha256").update(archive).digest("hex");
	if (digest !== entry.archive.sha256) {
		fail(`sha256 mismatch for ${hutchPlatform}`);
	}

	const name = `@electrobun/hutch-${os}-${cpu}`;
	const packageRoot = join(outputRoot, `hutch-${os}-${cpu}`);
	const extractRoot = join(packageRoot, ".extract");
	mkdirSync(extractRoot, { recursive: true });
	const archivePath = join(extractRoot, "hutch.tar.gz");
	writeFileSync(archivePath, archive);
	execFileSync("tar", ["xzf", archivePath, "-C", extractRoot]);

	const extractedRoot = join(
		extractRoot,
		`hutch-v${hutchVersion}-${hutchPlatform}`,
	);
	const binSource = join(extractedRoot, "bin");
	if (!existsSync(binSource)) fail(`archive for ${hutchPlatform} has no bin/`);
	cpSync(binSource, join(packageRoot, "bin"), { recursive: true });
	const releaseMetadata = join(extractedRoot, "hutch-release.json");
	if (existsSync(releaseMetadata)) {
		cpSync(releaseMetadata, join(packageRoot, "hutch-release.json"));
	}
	if (os !== "win32") {
		for (const binary of ["hutch", "hutch-engine"]) {
			chmodSync(join(packageRoot, "bin", binary), 0o755);
		}
	}
	rmSync(extractRoot, { recursive: true, force: true });

	writeFileSync(
		join(packageRoot, "package.json"),
		JSON.stringify(
			{
				name,
				version: packageVersion,
				description: `Hutch ${hutchVersion} launcher and engine for ${os}-${cpu}, vendored for the electrobun npm package.`,
				license: "MIT",
				repository: bootstrap.repository,
				os: [os],
				cpu: [cpu],
				files: ["bin", "hutch-release.json"],
			},
			null,
			"\t",
		) + "\n",
	);
	console.log(`built ${name}@${packageVersion} (hutch ${hutchVersion})`);
}

console.log(`platform packages ready under ${outputRoot}`);
