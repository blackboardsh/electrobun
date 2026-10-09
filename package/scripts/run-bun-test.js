import { spawnSync } from "node:child_process";
import { isDirectEntry, resolveTestArgs } from "./run-cottontail-test.js";

// Keep node:test suites on their dedicated Node tasks. Hutch resolves its
// pinned Bun; an explicit selection also overrides local Cottontail tooling.
export function runBunTests(paths, {
	spawn = spawnSync,
	hutch = process.env.HUTCH_BINARY || "hutch",
	environment = process.env,
	report = console.error,
} = {}) {
	if (paths.length === 0) {
		report("No test files matched the requested paths");
		return 1;
	}
	const options = {
		env: { ...environment, HUTCH_RUNTIME: "bun" },
		stdio: "inherit",
	};
	const probe = spawn(hutch, [
		"-e",
		"if (!process.versions.bun || process.versions.cottontail) process.exit(1)",
	], options);
	if (probe.status !== 0 || probe.error) {
		report("The selected Hutch must support the Bun script runner; rebuild Hutch or update its release pin.");
		return 1;
	}
	const result = spawn(hutch, ["test", ...paths], options);
	if (result.error) report(result.error.message);
	return result.status ?? 1;
}

if (isDirectEntry(import.meta.url, process.argv[1])) {
	process.exitCode = runBunTests(resolveTestArgs(process.argv.slice(2)));
}
