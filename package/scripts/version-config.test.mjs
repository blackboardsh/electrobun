import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { updateKitchenVersions } from "./version-config.mjs";

test("release bumps update both Kitchen product and app versions", () => {
	const source = readFileSync(
		new URL("../../kitchen/electrobun.config.ts", import.meta.url),
		"utf8",
	);
	const updated = updateKitchenVersions(source, "2.3.4-beta.5");

	assert.match(
		updated,
		/electrobun:\s*\{\s*version:\s*"2\.3\.4-beta\.5"/,
	);
	assert.match(
		updated,
		/app:\s*\{[\s\S]*?version:\s*"2\.3\.4-beta\.5"/,
	);
	assert.equal((updated.match(/2\.3\.4-beta\.5/g) ?? []).length, 2);
});

test("release bumps fail instead of publishing a partially updated config", () => {
	assert.throws(
		() =>
			updateKitchenVersions(
				'export default { app: { version: "1.0.0" } };',
				"2.0.0",
			),
		/Could not find electrobun\.version/,
	);
	assert.throws(
		() =>
			updateKitchenVersions(
				'export default { electrobun: { version: "1.0.0" } };',
				"2.0.0",
			),
		/Could not find app\.version/,
	);
});
