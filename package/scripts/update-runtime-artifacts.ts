import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const lockPath = join(import.meta.dir, "..", "runtime-artifacts.lock.json");
const current = JSON.parse(readFileSync(lockPath, "utf8"));
const requiredPlatforms = [
	"macos-arm64",
	"linux-x64",
	"linux-arm64",
	"windows-x64",
];

async function loadRelease(name: string, url: string) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Could not fetch ${name} release: ${response.status} ${response.statusText}`);
	}

	const release = await response.json();
	if (release?.schema !== 2 || release?.name !== name) {
		throw new Error(`Unexpected ${name} release manifest from ${url}`);
	}
	for (const platform of requiredPlatforms) {
		const archive = release.platforms?.[platform]?.archive;
		if (!archive?.url || !archive?.sha256 || !archive?.size) {
			throw new Error(`${name} release is missing ${platform}`);
		}
	}
	return release;
}

const [cottontail, dashCli] = await Promise.all([
	loadRelease("cottontail", current.sources.cottontail),
	loadRelease("dash-cli", current.sources.dashCli),
]);

if (
	dashCli.cottontail &&
	(dashCli.cottontail.version !== cottontail.version ||
		dashCli.cottontail.revision !== cottontail.revision)
) {
	throw new Error(
		`Dash CLI embeds Cottontail ${dashCli.cottontail.version}@${dashCli.cottontail.revision}, but latest Cottontail is ${cottontail.version}@${cottontail.revision}`,
	);
}

writeFileSync(
	lockPath,
	`${JSON.stringify({ schema: 1, sources: current.sources, cottontail, dashCli }, null, 2)}\n`,
);

console.log(
	`Pinned Cottontail ${cottontail.version}@${cottontail.revision} and Dash CLI ${dashCli.version}@${dashCli.revision}`,
);
