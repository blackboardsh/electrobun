import { describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isExpectedKitchenInstaller,
	kitchenArtifactPrefixes,
} from "./validate-kitchen-artifacts";

describe("Kitchen release artifact validation", () => {
	for (const channel of ["stable", "canary"] as const) {
		test(`${channel} release validation requires a hash-bound sidecar and legacy-compatible update.json`, () => {
			const root = mkdtempSync(join(tmpdir(), "kitchen-sidecar-"));
			const prefix = `${channel}-linux-x64`;
			const update = { schemaVersion: 1, identifier: "sh.blackboard.electrobun-kitchen", channel,
				version: "1.2.3", hash: "new123", platform: "linux", arch: "x64",
				artifact: { file: `${prefix}-Example.tar.zst` } };
			const checksum = { tarSha256: "a".repeat(64), tarSize: 4096 };
			const updatePath = join(root, `${prefix}-update.json`);
			const checksumPath = join(root, `${prefix}-${update.hash}-checksum.json`);
			const validate = () => Bun.spawnSync([process.execPath, join(import.meta.dir, "validate-kitchen-artifacts.ts"),
				root, channel, "linux", "x64", update.version]);
			try {
				writeFileSync(updatePath, JSON.stringify(update));
				writeFileSync(join(root, update.artifact.file), "archive");
				writeFileSync(join(root, `${channel === "stable" ? "linux-x64" : prefix}-Example-Setup.tar.gz`), "installer");
				expect(validate().exitCode).not.toBe(0);
				writeFileSync(checksumPath, JSON.stringify(checksum));
				expect(validate().exitCode).toBe(0);
				writeFileSync(updatePath, JSON.stringify({ ...update, artifact: { ...update.artifact, ...checksum } }));
				expect(validate().stderr.toString()).toContain("original update metadata shape");
				writeFileSync(updatePath, JSON.stringify(update));
				renameSync(checksumPath, join(root, `${prefix}-other456-checksum.json`));
				expect(validate().exitCode).not.toBe(0);
				for (const invalid of [{ tarSize: 4096 }, { ...checksum, tarSha256: "invalid" }, { ...checksum, tarSize: 0 }]) {
					writeFileSync(checksumPath, JSON.stringify(invalid));
					expect(validate().exitCode).not.toBe(0);
				}
			} finally { rmSync(root, { recursive: true, force: true }); }
		});
	}

	test("stable updates stay channel-prefixed while installers are unsuffixed", () => {
		const prefixes = kitchenArtifactPrefixes("stable", "win", "x64");
		expect(prefixes).toEqual({
			update: "stable-win-x64",
			installer: "win-x64",
		});
		expect(
			isExpectedKitchenInstaller(
				"win-x64-ElectrobunKitchenSink-Setup.zip",
				prefixes.installer,
				".zip",
			),
		).toBe(true);
		expect(
			isExpectedKitchenInstaller(
				"stable-win-x64-ElectrobunKitchenSink-Setup.zip",
				prefixes.installer,
				".zip",
			),
		).toBe(false);
	});

	test("canary updates and installers share the canary prefix", () => {
		const prefixes = kitchenArtifactPrefixes("canary", "linux", "arm64");
		expect(prefixes).toEqual({
			update: "canary-linux-arm64",
			installer: "canary-linux-arm64",
		});
		expect(
			isExpectedKitchenInstaller(
				"canary-linux-arm64-ElectrobunKitchenSink-Setup-canary.tar.gz",
				prefixes.installer,
				".tar.gz",
			),
		).toBe(true);
	});
});
