import assert from "node:assert/strict";

// The Node runner and Hutch can have different executable architectures on
// Windows ARM. The already-built devkit defines the fixture's artifact target.
export function updaterLifecycleBuildTarget({
	manifest,
	platform = process.platform,
	env = process.env,
}) {
	const os = { win32: "win", darwin: "macos", linux: "linux" }[platform];
	assert.ok(os, `unsupported updater lifecycle platform: ${platform}`);
	assert.equal(manifest?.schemaVersion, 1, "unsupported lifecycle devkit manifest schema");
	assert.equal(manifest?.product?.name, "electrobun", "lifecycle devkit must describe Electrobun");
	assert.equal(manifest?.target?.os, os, "lifecycle devkit must target the current operating system");
	const arch = manifest?.target?.arch;
	assert.ok(arch === "arm64" || arch === "x64", "unsupported lifecycle devkit architecture");
	const requested = env.HUTCH_ELECTROBUN_TARGET_ARCH;
	assert.ok(
		requested === undefined || requested === arch,
		`HUTCH_ELECTROBUN_TARGET_ARCH=${requested} conflicts with the built ${os}-${arch} devkit`,
	);
	return {
		os,
		arch,
		environment: { ...env, HUTCH_ELECTROBUN_TARGET_ARCH: arch },
	};
}
