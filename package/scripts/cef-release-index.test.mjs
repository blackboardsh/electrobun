import assert from "node:assert/strict";
import test from "node:test";
import { CEF_PLATFORMS, latestCommonStableCEF } from "./cef-release-index.mjs";

function release(platform, major, channel = "stable") {
	const chromium_version = `${major}.0.8000.1`;
	const cef_version = `${major}.0.7+gabcdef0+chromium-${chromium_version}`;
	return { cef_version, chromium_version, channel, files: [{
		type: "minimal", name: `cef_binary_${cef_version}_${platform}_minimal.tar.bz2`,
		sha1: "a".repeat(40), size: 100,
	}] };
}
function index() {
	return Object.fromEntries(CEF_PLATFORMS.map((platform) => [platform, {
		versions: [release(platform, 99), release(platform, 156), release(platform, 155)],
	}]));
}

test("selects the numerically newest stable version across unsorted platform indexes", () => {
	assert.equal(latestCommonStableCEF(index()).cef_version, "156.0.7+gabcdef0");
});
test("waits for the last platform to publish its minimal artifact", () => {
	const data = index();
	data.windowsarm64.versions[1].files[0].type = "standard";
	assert.equal(latestCommonStableCEF(data).cef_version, "155.0.7+gabcdef0");
});
test("does not select prereleases or mismatched Chromium builds", () => {
	const data = index();
	data.macosx64.versions[1].channel = "beta";
	data.linux64.versions[2].chromium_version = "155.0.8000.2";
	assert.equal(latestCommonStableCEF(data).cef_version, "99.0.7+gabcdef0");
});
test("rejects incomplete metadata and missing platforms", () => {
	const data = index();
	delete data.linuxarm64;
	assert.throws(() => latestCommonStableCEF(data), /all six/);
	const invalid = index();
	for (const version of invalid.macosarm64.versions) version.files[0].sha1 = "";
	assert.throws(() => latestCommonStableCEF(invalid), /all six/);
});
