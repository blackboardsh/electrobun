import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

type Platform = "macos" | "linux" | "win";
type Channel = "canary" | "production";

const fail = (message: string): never => {
	throw new Error(`Kitchen artifact validation failed: ${message}`);
};

const requireArgument = (value: string | undefined, name: string): string => {
	if (!value) fail(`missing ${name} argument`);
	return value;
};

const requireArtifact = (
	files: string[],
	description: string,
	matches: (file: string) => boolean,
): string => {
	const file = files.find(matches);
	if (!file) fail(`missing ${description}`);
	return file;
};

async function main() {
	const artifactsDir = requireArgument(process.argv[2], "artifacts directory");
	const channel = requireArgument(process.argv[3], "channel") as Channel;
	const platform = requireArgument(process.argv[4], "platform") as Platform;
	const arch = requireArgument(process.argv[5], "architecture");
	const version = requireArgument(process.argv[6], "version");

	if (channel !== "canary" && channel !== "production") {
		fail(`unsupported channel ${JSON.stringify(channel)}`);
	}
	if (platform !== "macos" && platform !== "linux" && platform !== "win") {
		fail(`unsupported platform ${JSON.stringify(platform)}`);
	}
	if (arch !== "arm64" && arch !== "x64") {
		fail(`unsupported architecture ${JSON.stringify(arch)}`);
	}

	const prefix = `${channel}-${platform}-${arch}`;
	const files = (await readdir(artifactsDir)).filter((file) =>
		file.startsWith(`${prefix}-`),
	);
	const updateName = `${prefix}-update.json`;
	const archiveSuffix = platform === "macos" ? ".app.tar.zst" : ".tar.zst";
	const installerSuffix =
		platform === "macos" ? ".dmg" : platform === "win" ? ".zip" : ".tar.gz";

	requireArtifact(files, updateName, (file) => file === updateName);
	requireArtifact(
		files,
		`full update archive ending in ${archiveSuffix}`,
		(file) => file.endsWith(archiveSuffix),
	);
	requireArtifact(
		files,
		`${platform} installer ending in ${installerSuffix}`,
		(file) => file.endsWith(installerSuffix),
	);

	for (const file of files) {
		const fileStat = await stat(join(artifactsDir, file));
		if (!fileStat.isFile() || fileStat.size === 0) {
			fail(`${file} is not a non-empty file`);
		}
	}

	const update = JSON.parse(
		await readFile(join(artifactsDir, updateName), "utf8"),
	) as Record<string, unknown>;
	if (update.version !== version) {
		fail(
			`${updateName} has version ${JSON.stringify(update.version)}; expected ${JSON.stringify(version)}`,
		);
	}
	if (update.platform !== platform) {
		fail(
			`${updateName} has platform ${JSON.stringify(update.platform)}; expected ${JSON.stringify(platform)}`,
		);
	}
	if (update.arch !== arch) {
		fail(
			`${updateName} has architecture ${JSON.stringify(update.arch)}; expected ${JSON.stringify(arch)}`,
		);
	}
	if (typeof update.hash !== "string" || update.hash.length === 0) {
		fail(`${updateName} does not contain a non-empty hash`);
	}

	console.log(`Validated ${files.length} Kitchen artifacts for ${prefix}.`);
}

await main();
