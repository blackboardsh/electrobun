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
				"staged/kitchen-macos-arm64/production-macos-arm64-update.json",
			),
		).toBe("kitchen/production-macos-arm64-update.json");
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
	});
});
