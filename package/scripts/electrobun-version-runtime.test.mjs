import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const packageManifest = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("Hutch evaluates the bundled Electrobun product version", () => {
	const hutch = process.env.HUTCH_BINARY || "hutch";
	const result = spawnSync(
		hutch,
		["scripts/fixtures/electrobun-version-runtime.ts"],
		{
			cwd: packageDirectory,
			encoding: "utf8",
		},
	);

	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), {
		packageVersion: packageManifest.version,
	});
});
