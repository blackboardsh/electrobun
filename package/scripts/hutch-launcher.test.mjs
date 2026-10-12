import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveHutchBinary } from "./dev.ts";
import { selectHutchBinary } from "./hutch-launcher.mjs";

test("nested commands retain their launching Hutch unless explicitly overridden", () => {
	const environment = Object.freeze({
		HUTCH_LAUNCHER_PATH: "C:\\tools with spaces\\hutch-canary.exe",
	});
	assert.equal(selectHutchBinary(environment), environment.HUTCH_LAUNCHER_PATH);
	assert.equal(selectHutchBinary({ ...environment, HUTCH_BINARY: "/local/hutch" }), "/local/hutch");
	assert.equal(selectHutchBinary({ ...environment, HUTCH_BINARY: "" }), environment.HUTCH_LAUNCHER_PATH);
	assert.equal(selectHutchBinary({ HUTCH_BINARY: "hutch-custom" }), "hutch-custom");
	assert.equal(selectHutchBinary({}), "hutch");
});

test("dev commands validate the selected launcher and preserve relative explicit overrides", () => {
	const directory = mkdtempSync(join(tmpdir(), "electrobun-hutch-selection-"));
	try {
		const launcher = join(directory, "hutch canary.exe");
		const override = join(directory, "local-hutch.exe");
		writeFileSync(launcher, "launcher fixture");
		writeFileSync(override, "override fixture");
		assert.equal(resolveHutchBinary(directory, "", launcher), launcher);
		assert.equal(resolveHutchBinary(directory, "local-hutch.exe", launcher), override);
		assert.equal(resolveHutchBinary(directory, "", ""), "hutch");
		assert.throws(() => resolveHutchBinary(directory, "missing.exe", launcher), /HUTCH_BINARY points to a missing executable/);
		assert.throws(() => resolveHutchBinary(directory, "", join(directory, "missing.exe")), /HUTCH_LAUNCHER_PATH points to a missing executable/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a child launched without a Hutch override keeps its parent's executable and architecture", () => {
	// Use Node as an executable launcher fixture so this contract runs on every
	// platform without installing either Hutch channel. A bare `hutch` fallback
	// cannot satisfy this probe, even if an unrelated Hutch happens to be on PATH.
	const program = `
		import { spawnSync } from 'node:child_process';
		import { resolveHutchBinary } from ${JSON.stringify(new URL("./dev.ts", import.meta.url).href)};
		const launcher = resolveHutchBinary(process.cwd());
		const child = spawnSync(launcher, ['-p', 'JSON.stringify({binary: process.execPath, arch: process.arch})'], { encoding: 'utf8' });
		if (child.error || child.status !== 0) throw child.error || new Error(child.stderr);
		process.stdout.write(child.stdout);
	`;
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
		env: { ...process.env, HUTCH_BINARY: "", HUTCH_LAUNCHER_PATH: process.execPath },
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.ifError(child.error);
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), { binary: process.execPath, arch: process.arch });
});
