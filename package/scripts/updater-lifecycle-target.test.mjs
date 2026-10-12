import assert from "node:assert/strict";
import test from "node:test";
import { updaterLifecycleBuildTarget, updaterLifecycleHutchBinary } from "./updater-lifecycle-target.mjs";

test("lifecycle builds retain their Hutch launcher and prioritize explicit overrides", () => {
	const inherited = Object.freeze({ HUTCH_LAUNCHER_PATH: "C:\\tools\\hutch-canary.exe" });
	assert.equal(updaterLifecycleHutchBinary(inherited), inherited.HUTCH_LAUNCHER_PATH);
	assert.equal(updaterLifecycleHutchBinary({ ...inherited, HUTCH_BINARY: "./local-hutch.exe" }), "./local-hutch.exe");
	assert.equal(updaterLifecycleHutchBinary({
		...inherited,
		HUTCH_BINARY: "./local-hutch.exe",
		ELECTROBUN_UPDATER_E2E_HUTCH: "./lifecycle-hutch.exe",
	}), "./lifecycle-hutch.exe");
	assert.equal(updaterLifecycleHutchBinary({}), "hutch");
});

const manifest = (os, arch) => ({
	schemaVersion: 1,
	product: { name: "electrobun", version: "2.0.3-beta.18" },
	target: { os, arch },
});

for (const arch of ["x64", "arm64"]) {
	test(`Windows lifecycle uses the ${arch} devkit for both artifact names and Hutch's target`, () => {
		const env = { PATH: "fixture-tools", HUTCH_ELECTROBUN_DEVKIT_ROOT: "fixture-devkit" };
		const selected = updaterLifecycleBuildTarget({ manifest: manifest("win", arch), platform: "win32", env });
		assert.equal(`stable-${selected.os}-${selected.arch}-update.json`, `stable-win-${arch}-update.json`);
		assert.equal(selected.environment.HUTCH_ELECTROBUN_TARGET_ARCH, arch);
		assert.equal(selected.environment.HUTCH_ELECTROBUN_DEVKIT_ROOT, "fixture-devkit");
		assert.equal(selected.environment.PATH, "fixture-tools");
		assert.equal(env.HUTCH_ELECTROBUN_TARGET_ARCH, undefined, "selection must not mutate the parent environment");
	});
}

test("an explicit matching target is preserved, while a conflicting target fails before building", () => {
	const devkit = manifest("win", "x64");
	assert.equal(updaterLifecycleBuildTarget({ manifest: devkit, platform: "win32", env: { HUTCH_ELECTROBUN_TARGET_ARCH: "x64" } }).arch, "x64");
	for (const target of ["arm64", "", "../x64"]) {
		assert.throws(() => updaterLifecycleBuildTarget({ manifest: devkit, platform: "win32", env: { HUTCH_ELECTROBUN_TARGET_ARCH: target } }), /conflicts with the built win-x64 devkit/);
	}
});

test("foreign OS and invalid devkits fail before an artifact or installer can be selected", () => {
	for (const devkit of [null, {}, { ...manifest("win", "x64"), schemaVersion: 2 }, { ...manifest("win", "x64"), product: { name: "other" } }, manifest("linux", "x64"), manifest("win", "ia32")]) {
		assert.throws(() => updaterLifecycleBuildTarget({ manifest: devkit, platform: "win32", env: {} }));
	}
});

test("the same target contract preserves native macOS and Linux fixtures", () => {
	for (const [platform, os] of [["darwin", "macos"], ["linux", "linux"]]) {
		for (const arch of ["x64", "arm64"]) {
			const selected = updaterLifecycleBuildTarget({ manifest: manifest(os, arch), platform, env: {} });
			assert.equal(selected.os, os);
			assert.equal(selected.arch, arch);
			assert.equal(selected.environment.HUTCH_ELECTROBUN_TARGET_ARCH, arch);
		}
	}
});
