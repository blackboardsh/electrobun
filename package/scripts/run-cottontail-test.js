import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function collectTestFiles(directory, readDirectory = readdirSync) {
	const files = [];
	for (const entry of readDirectory(directory, { withFileTypes: true }).sort(
		(a, b) => a.name.localeCompare(b.name),
	)) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...collectTestFiles(path, readDirectory));
		else if (entry.isFile() && testFilePattern.test(entry.name)) files.push(path);
	}
	return files;
}

export function resolveTestArgs(
	requestedTestPaths,
	{
		stat = statSync,
		collect = (directory) => collectTestFiles(directory),
	} = {},
) {
	return requestedTestPaths.flatMap((path) => {
		try {
			return stat(path).isDirectory() ? collect(path) : [path];
		} catch {
			// Preserve non-filesystem filters for Cottontail to interpret.
			return [path];
		}
	});
}

function describeFailure(result) {
	if (result.error) return result.error.message;
	if (result.signal) return `signal ${result.signal}`;
	return `exit status ${result.status ?? 1}`;
}

export function runTestsIndividually(
	cottontailBinary,
	testArgs,
	{
		spawn = spawnSync,
		reportFailure = (testArg, result) => {
			console.error(
				`Cottontail test ${JSON.stringify(testArg)} failed: ${describeFailure(result)}`,
			);
		},
	} = {},
) {
	const failures = [];
	for (const testArg of testArgs) {
		// Cottontail currently treats multiple positional filters differently on
		// Windows and can report success after selecting zero tests. One process per
		// resolved file/filter makes selection portable and keeps later tests running.
		const result = spawn(cottontailBinary, ["test", testArg], {
			stdio: "inherit",
		});
		if (result.error || result.status !== 0) {
			failures.push({ testArg, result });
			reportFailure(testArg, result);
		}
	}
	return failures;
}

export function testExitCode(failures) {
	return failures.length === 0 ? 0 : 1;
}

export function isDirectEntry(moduleUrl, argvPath) {
	return Boolean(argvPath) && pathToFileURL(resolve(argvPath)).href === moduleUrl;
}

function main() {
	const requestedTestPaths = process.argv.slice(2);
	if (requestedTestPaths.length === 0) {
		console.error("Usage: node scripts/run-cottontail-test.js <test-path> [...]");
		return 2;
	}

	// Cottontail's Windows test-filter matcher does not currently expand directory
	// arguments. Resolve existing directories here so the repository's canonical
	// `test:unit` command selects the same files on every host.
	const testArgs = resolveTestArgs(requestedTestPaths);
	if (testArgs.length === 0) {
		console.error("No test files matched the requested paths");
		return 1;
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
			return located.status || 1;
		}
		cottontailBinary = located.stdout.trim();
	}

	if (!cottontailBinary) {
		console.error("Hutch returned an empty Cottontail path");
		return 1;
	}

	const failures = runTestsIndividually(cottontailBinary, testArgs);
	if (failures.length > 0) {
		console.error(
			`Cottontail tests: ${failures.length} of ${testArgs.length} invocations failed`,
		);
	}
	return testExitCode(failures);
}

if (isDirectEntry(import.meta.url, process.argv[1])) {
	process.exitCode = main();
}
