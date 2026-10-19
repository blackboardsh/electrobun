import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { windowsBinaryArchitecture, validateWindowsReleaseArchitecture } from "./windows-binary-architecture.mjs";

function executable(machine) {
	const buffer = Buffer.alloc(256);
	buffer.writeUInt16LE(0x5a4d, 0);
	buffer.writeUInt32LE(128, 0x3c);
	buffer.writeUInt32LE(0x4550, 128);
	buffer.writeUInt16LE(machine, 132);
	return buffer;
}

test("checks every executable and DLL, including nested CEF dependencies", () => {
	const root = mkdtempSync(join(tmpdir(), "electrobun-pe-"));
	try {
		mkdirSync(join(root, "cef"));
		writeFileSync(join(root, "launcher.exe"), executable(0xaa64));
		writeFileSync(join(root, "cef", "libcef.dll"), executable(0xaa64));
		writeFileSync(join(root, "main.js"), "javascript");
		assert.equal(validateWindowsReleaseArchitecture(root, "arm64"), 2);
		writeFileSync(join(root, "cef", "libcef.dll"), executable(0x8664));
		assert.throws(() => validateWindowsReleaseArchitecture(root, "arm64"), /Expected arm64, found x64/);
		assert.equal(windowsBinaryArchitecture(join(root, "cef", "libcef.dll")), "x64");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects malformed or unsupported PE files", () => {
	const root = mkdtempSync(join(tmpdir(), "electrobun-pe-"));
	const path = join(root, "invalid.exe");
	try {
		for (const data of [Buffer.from("truncated"), executable(0x14c), Buffer.alloc(256)]) {
			writeFileSync(path, data);
			assert.throws(() => windowsBinaryArchitecture(path));
		}
		const badOffset = executable(0xaa64);
		badOffset.writeUInt32LE(1024, 0x3c);
		writeFileSync(path, badOffset);
		assert.throws(() => windowsBinaryArchitecture(path), /Invalid PE header/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
