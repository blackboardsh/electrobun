import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isKitchenUpdateManifest,
	KITCHEN_ARTIFACT_BUCKET,
	KITCHEN_ARTIFACT_PREFIX,
	KITCHEN_ARTIFACT_PUBLIC_BASE_URL,
	kitchenArtifactKey,
	putKitchenArtifact,
} from "./upload-kitchen-artifacts";

describe("Kitchen artifact publishing", () => {
	test("uploads a large artifact with one signed PUT and reports HTTP failures", async () => {
		const directory = mkdtempSync(join(tmpdir(), "kitchen-upload-"));
		const path = join(directory, "artifact.bin");
		const payload = Buffer.alloc(6 * 1024 * 1024, 42);
		writeFileSync(path, payload);
		const requests: { method: string; body: Buffer }[] = [];
		let status = 200;
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				requests.push({ method: request.method, body: Buffer.from(await request.arrayBuffer()) });
				return new Response("", { status });
			},
		});
		const client = {
			presign(key: string, options: unknown) {
				expect(key).toBe("kitchen/artifact.bin");
				expect(options).toEqual({ method: "PUT", expiresIn: 3600 });
				return `http://127.0.0.1:${server.port}/artifact`;
			},
		};
		try {
			await putKitchenArtifact(client, "kitchen/artifact.bin", Bun.file(path));
			expect(requests).toHaveLength(1);
			expect(requests[0]?.method).toBe("PUT");
			expect(requests[0]?.body.equals(payload)).toBe(true);
			status = 503;
			await expect(putKitchenArtifact(client, "kitchen/artifact.bin", Bun.file(path)))
				.rejects.toThrow("HTTP 503");
		} finally {
			server.stop(true);
			rmSync(directory, { recursive: true, force: true });
		}
	});

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
