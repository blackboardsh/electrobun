import { describe, expect, test } from "bun:test";
import {
	isKitchenUpdateManifest,
	KITCHEN_ARTIFACT_BUCKET,
	KITCHEN_ARTIFACT_PREFIX,
	KITCHEN_ARTIFACT_PUBLIC_BASE_URL,
	kitchenArtifactKey,
} from "./upload-kitchen-artifacts";

describe("Kitchen artifact publishing", () => {
	test("uses the shared Electrobun artifact bucket and Kitchen prefix", () => {
		expect(KITCHEN_ARTIFACT_BUCKET).toBe("electrobun-artifacts");
		expect(KITCHEN_ARTIFACT_PREFIX).toBe("kitchen");
		expect(KITCHEN_ARTIFACT_PUBLIC_BASE_URL).toBe(
			"https://electrobun-artifacts.blackboard.sh/kitchen",
		);
	});

	test("flattens staged platform artifacts into the Kitchen prefix", () => {
		expect(
			kitchenArtifactKey(
				"staged/kitchen-macos-arm64/stable-macos-arm64-update.json",
			),
		).toBe("kitchen/stable-macos-arm64-update.json");
		expect(
			kitchenArtifactKey(
				"staged/kitchen-win-x64/win-x64-ElectrobunKitchenSink-Setup.exe",
			),
		).toBe("kitchen/win-x64-ElectrobunKitchenSink-Setup.exe");
		expect(
			kitchenArtifactKey(
				"staged/kitchen-win-x64/canary-win-x64-ElectrobunKitchenSink-Setup-canary.exe",
			),
		).toBe(
			"kitchen/canary-win-x64-ElectrobunKitchenSink-Setup-canary.exe",
		);
	});

	test("recognizes update manifests that must publish last", () => {
		expect(
			isKitchenUpdateManifest(
				"kitchen/canary-linux-x64-update.json",
			),
		).toBe(true);
		expect(
			isKitchenUpdateManifest(
				"kitchen/canary-linux-x64-ElectrobunKitchenSink.tar.zst",
			),
		).toBe(false);
	});

	test("rejects unrelated files", () => {
		expect(() => kitchenArtifactKey("electrobun-core-linux-x64.tar.gz")).toThrow(
			"Unexpected Kitchen artifact filename",
		);
		expect(() =>
			kitchenArtifactKey("production-win-x64-update.json"),
		).toThrow("Unexpected Kitchen artifact filename");
		expect(() =>
			kitchenArtifactKey("stable-win-x64-Example-Setup.exe"),
		).toThrow("Unexpected Kitchen artifact filename");
	});
});
