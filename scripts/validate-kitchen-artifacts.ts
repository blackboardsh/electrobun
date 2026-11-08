import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export type Platform = "macos" | "linux" | "win";
export type Channel = "canary" | "stable";

export const kitchenArtifactPrefixes = (
	channel: Channel,
	platform: Platform,
	arch: string,
): { update: string; installer: string } => {
	const update = `${channel}-${platform}-${arch}`;
	return {
		update,
		installer: channel === "stable" ? `${platform}-${arch}` : update,
	};
};

export const isExpectedKitchenInstaller = (
	file: string,
	installerPrefix: string,
	installerSuffix: string,
): boolean =>
	file.startsWith(`${installerPrefix}-`) && file.endsWith(installerSuffix);

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

	if (channel !== "canary" && channel !== "stable") {
		fail(`unsupported channel ${JSON.stringify(channel)}`);
	}
	if (platform !== "macos" && platform !== "linux" && platform !== "win") {
		fail(`unsupported platform ${JSON.stringify(platform)}`);
	}
	if (arch !== "arm64" && arch !== "x64") {
		fail(`unsupported architecture ${JSON.stringify(arch)}`);
	}

	const prefixes = kitchenArtifactPrefixes(channel, platform, arch);
	const updatePrefix = prefixes.update;
	// Stable installers keep their user-facing unsuffixed bundle name. Update
	// artifacts remain channel-prefixed because their URLs are channel scoped.
	const installerPrefix = prefixes.installer;
	const files = (await readdir(artifactsDir)).filter(
		(file) =>
			file.startsWith(`${updatePrefix}-`) ||
			file.startsWith(`${installerPrefix}-`),
	);
	const updateName = `${updatePrefix}-update.json`;
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
		(file) => isExpectedKitchenInstaller(file, installerPrefix, installerSuffix),
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
	if (typeof update.hash !== "string" || !/^[a-z0-9]{1,13}$/.test(update.hash)) {
		fail(`${updateName} does not contain a valid build hash`);
	}
	const artifact = update.artifact as Record<string, unknown> | undefined;
	if (Object.keys(update).sort().join(",") !== "arch,artifact,channel,hash,identifier,platform,schemaVersion,version" ||
		update.schemaVersion !== 1 || update.channel !== channel ||
		typeof update.identifier !== "string" || !update.identifier ||
		!artifact || Array.isArray(artifact) || Object.keys(artifact).join(",") !== "file" ||
		typeof artifact.file !== "string" || !files.includes(artifact.file) ||
		!artifact.file.startsWith(`${updatePrefix}-`) || !artifact.file.endsWith(archiveSuffix)) {
		fail(`${updateName} must retain the original update metadata shape with artifact: { file }`);
	}
	const checksumName = `${updatePrefix}-${update.hash}-checksum.json`;
	requireArtifact(files, checksumName, file => file === checksumName);
	const checksum = JSON.parse(await readFile(join(artifactsDir, checksumName), "utf8"));
	if (!checksum || Array.isArray(checksum) ||
		Object.keys(checksum).sort().join(",") !== "tarSha256,tarSize" ||
		typeof checksum.tarSha256 !== "string" || !/^[a-f0-9]{64}$/.test(checksum.tarSha256) ||
		!Number.isSafeInteger(checksum.tarSize) || checksum.tarSize <= 0) {
		fail(`${checksumName} must contain the exact tar SHA-256 and byte size`);
	}

	console.log(`Validated ${files.length} Kitchen artifacts for ${updatePrefix}.`);
}

if (import.meta.main) await main();
