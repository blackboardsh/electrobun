import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const requestedTestPaths = process.argv.slice(2);
if (requestedTestPaths.length === 0) {
	console.error("Usage: node scripts/run-cottontail-test.js <test-path> [...]");
	process.exit(2);
}

const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function collectTestFiles(directory) {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...collectTestFiles(path));
		else if (entry.isFile() && testFilePattern.test(entry.name)) files.push(path);
	}
	return files;
}

// Cottontail's Windows test-filter matcher does not currently expand directory
// arguments. Resolve existing directories here so the repository's canonical
// `test:unit` command selects the same files on every host.
const testArgs = requestedTestPaths.flatMap((path) => {
	try {
		return statSync(path).isDirectory() ? collectTestFiles(path) : [path];
	} catch {
		// Preserve non-filesystem filters for Cottontail to interpret.
		return [path];
	}
});

if (testArgs.length === 0) {
	console.error("No test files matched the requested paths");
	process.exit(1);
}

let cottontailBinary = process.env.COTTONTAIL_BINARY;
if (!cottontailBinary) {
	const hutchBinary = process.env.HUTCH_BINARY || "hutch";
	const located = spawnSync(hutchBinary, ["cottontail", "path"], {
		encoding: "utf8",
	});
	if (located.error || located.status !== 0) {
		if (located.stderr) process.stderr.write(located.stderr);
		console.error(
			`Unable to locate Cottontail through ${hutchBinary}: ${located.error?.message ?? `exit ${located.status}`}`,
		);
		process.exit(located.status || 1);
	}
	cottontailBinary = located.stdout.trim();
}

if (!cottontailBinary) {
	console.error("Hutch returned an empty Cottontail path");
	process.exit(1);
}

const result = spawnSync(cottontailBinary, ["test", ...testArgs], {
	stdio: "inherit",
});
if (result.error) {
	console.error(`Unable to run Cottontail tests: ${result.error.message}`);
	process.exit(1);
}
process.exit(result.status ?? 1);
