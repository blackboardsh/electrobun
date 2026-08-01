import { spawnSync } from "node:child_process";

const testArgs = process.argv.slice(2);
if (testArgs.length === 0) {
	console.error("Usage: node scripts/run-cottontail-test.js <test-path> [...]");
	process.exit(2);
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
