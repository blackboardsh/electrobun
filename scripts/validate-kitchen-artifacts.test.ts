import { describe, expect, test } from "bun:test";
import {
	isExpectedKitchenInstaller,
	kitchenArtifactPrefixes,
} from "./validate-kitchen-artifacts";

describe("Kitchen release artifact validation", () => {
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
