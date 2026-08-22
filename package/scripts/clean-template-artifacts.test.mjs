import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanTemplateArtifacts } from "./clean-template-artifacts.mjs";

test("cleans generated template state without touching source files", () => {
	const scratch = mkdtempSync(join(tmpdir(), "electrobun-template-clean-"));
	try {
		const template = join(scratch, "example");
		mkdirSync(template, { recursive: true });
		writeFileSync(join(template, "hutch.config.ts"), "export default {};\n");
		writeFileSync(join(template, "src.ts"), "export {};\n");
		for (const directory of [
			".cottontail-tmp",
			".hutch",
			"artifacts",
			"build",
			"dist",
			"node_modules",
			"templates",
		]) {
			mkdirSync(join(template, directory), { recursive: true });
			writeFileSync(join(template, directory, "generated"), "generated\n");
		}
		writeFileSync(join(template, "cache.tsbuildinfo"), "generated\n");
		writeFileSync(join(template, ".DS_Store"), "generated\n");

		const unrelated = join(scratch, "unrelated");
		mkdirSync(join(unrelated, "node_modules"), { recursive: true });

		assert.equal(cleanTemplateArtifacts(scratch), 9);
		assert.equal(existsSync(join(template, "src.ts")), true);
		assert.equal(existsSync(join(template, "hutch.config.ts")), true);
		assert.equal(existsSync(join(template, "node_modules")), false);
		assert.equal(existsSync(join(template, ".hutch")), false);
		assert.equal(existsSync(join(template, "cache.tsbuildinfo")), false);
		assert.equal(existsSync(join(unrelated, "node_modules")), true);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("rejects a missing templates root", () => {
	assert.throws(
		() => cleanTemplateArtifacts(join(tmpdir(), "missing-electrobun-templates")),
		/Templates directory does not exist/,
	);
});
