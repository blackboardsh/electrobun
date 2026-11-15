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
		for (const [platform, arch] of [
			["macos", "arm64"], ["macos", "x64"],
			["linux", "arm64"], ["linux", "x64"],
			["win", "arm64"], ["win", "x64"],
		] as const) {
			test(`${channel}-${platform}-${arch} requires a fixed sidecar bound by JSON hash and legacy-compatible update.json`, () => {
				const root = mkdtempSync(join(tmpdir(), "kitchen-sidecar-"));
				const prefix = `${channel}-${platform}-${arch}`;
				const archiveSuffix = platform === "macos" ? ".app.tar.zst" : ".tar.zst";
				const installerSuffix = platform === "macos" ? ".dmg" : platform === "win" ? ".zip" : ".tar.gz";
				const update = { schemaVersion: 1, identifier: "sh.blackboard.electrobun-kitchen", channel,
					version: "1.2.3", hash: "new123", platform, arch,
					artifact: { file: `${prefix}-Example${archiveSuffix}` } };
				const checksum = { hash: update.hash, tarSha256: "a".repeat(64), tarSize: 4096 };
				const updatePath = join(root, `${prefix}-update.json`);
				const checksumPath = join(root, `${prefix}-checksum.json`);
				const legacyChecksumPath = join(root, `${prefix}-${update.hash}-checksum.json`);
				const validate = () => Bun.spawnSync([process.execPath, join(import.meta.dir, "validate-kitchen-artifacts.ts"),
					root, channel, platform, arch, update.version]);
				try {
					writeFileSync(updatePath, JSON.stringify(update));
					writeFileSync(join(root, update.artifact.file), "archive");
					writeFileSync(join(root, `${channel === "stable" ? `${platform}-${arch}` : prefix}-Example-Setup${installerSuffix}`), "installer");
					expect(validate().exitCode).not.toBe(0);
					writeFileSync(checksumPath, JSON.stringify(checksum));
					expect(validate().exitCode).toBe(0);
					writeFileSync(updatePath, JSON.stringify({ ...update, artifact: { ...update.artifact, ...checksum } }));
					expect(validate().stderr.toString()).toContain("original update metadata shape");
					writeFileSync(updatePath, JSON.stringify(update));
					renameSync(checksumPath, legacyChecksumPath);
					expect(validate().exitCode).not.toBe(0);
					for (const invalid of [
						{ tarSha256: checksum.tarSha256, tarSize: checksum.tarSize },
						{ ...checksum, hash: "other456" }, { ...checksum, hash: null },
						{ hash: update.hash, tarSize: 4096 },
						{ ...checksum, tarSha256: "invalid" }, { ...checksum, tarSize: 0 },
					]) {
						writeFileSync(checksumPath, JSON.stringify(invalid));
						expect(validate().exitCode).not.toBe(0);
					}
					// Rebuilding the same version replaces one fixed sidecar. Its JSON
					// must follow the new build hash, while update.json retains its original shape.
					writeFileSync(updatePath, JSON.stringify({ ...update, hash: "rebuilt456" }));
					writeFileSync(checksumPath, JSON.stringify({ ...checksum, hash: "rebuilt456" }));
					expect(validate().exitCode).toBe(0);
				} finally { rmSync(root, { recursive: true, force: true }); }
			});
		}
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
