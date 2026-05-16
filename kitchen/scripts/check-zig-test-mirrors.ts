import { join } from "node:path";

const kitchenRoot = import.meta.dir.endsWith("/scripts")
	? join(import.meta.dir, "..")
	: import.meta.dir;

const bunTestNames = new Set<string>();
const trackedBunTests: Array<{ name: string; category: string }> = [];
const trackedCategories = new Set(["BrowserWindow", "Tray", "Utils", "Screen"]);

const bunTestBlockPattern =
	/defineTest\s*\(\s*\{[\s\S]*?name:\s*"([^"]+)"[\s\S]*?category:\s*"([^"]+)"[\s\S]*?\}\s*\)/g;
const helperTestFactoryPattern =
	/function\s+([A-Za-z0-9_]+)\s*\(\s*([A-Za-z0-9_]+)[^)]*\)\s*\{[\s\S]*?defineTest\s*\(\s*\{[\s\S]*?(?:name\s*,|name:\s*\2\b)/g;
const zigMirrorPattern = /\.mirrors_bun_test_name\s*=\s*"([^"]+)"/g;

for await (const relativePath of new Bun.Glob("src/tests/**/*.ts").scan({
	cwd: kitchenRoot,
	onlyFiles: true,
})) {
	const filePath = join(kitchenRoot, relativePath);
	const source = await Bun.file(filePath).text();

	for (const match of source.matchAll(bunTestBlockPattern)) {
		const [, name, category] = match;
		bunTestNames.add(name);
		if (trackedCategories.has(category)) {
			trackedBunTests.push({ name, category });
		}
	}

	for (const match of source.matchAll(helperTestFactoryPattern)) {
		const [_, helperName] = match;
		const helperInvocationPattern = new RegExp(`${helperName}\\s*\\(\\s*"([^"]+)"`, "g");
		for (const helperInvocationMatch of source.matchAll(helperInvocationPattern)) {
			bunTestNames.add(helperInvocationMatch[1]);
		}
	}
}

const zigMainPath = join(kitchenRoot, "src/zig/main.zig");
const zigMainSource = await Bun.file(zigMainPath).text();
const mirroredNames = [...zigMainSource.matchAll(zigMirrorPattern)].map((match) => match[1]);

const duplicateMirrors = [...new Set(
	mirroredNames.filter((name, index) => mirroredNames.indexOf(name) !== index),
)];
const missingMirrorTargets = mirroredNames.filter((name) => !bunTestNames.has(name));
const uniqueMissingMirrorTargets = [...new Set(missingMirrorTargets)];
const uncoveredTrackedBunTests = trackedBunTests.filter(
	(test) => !mirroredNames.includes(test.name),
);

if (duplicateMirrors.length > 0) {
	console.error("Duplicate Zig mirror targets:");
	for (const name of duplicateMirrors) {
		console.error(`- ${name}`);
	}
	process.exit(1);
}

if (uniqueMissingMirrorTargets.length > 0) {
	console.error("Zig mirror targets that do not exist in Bun tests:");
	for (const name of uniqueMissingMirrorTargets) {
		console.error(`- ${name}`);
	}
	process.exit(1);
}

console.log(
	`Validated ${mirroredNames.length} Zig mirror target(s) against ${bunTestNames.size} Bun test name(s).`,
);

if (uncoveredTrackedBunTests.length > 0) {
	console.log("");
	console.log("Tracked Bun tests without a Zig mirror yet:");
	for (const test of uncoveredTrackedBunTests) {
		console.log(`- [${test.category}] ${test.name}`);
	}
}
