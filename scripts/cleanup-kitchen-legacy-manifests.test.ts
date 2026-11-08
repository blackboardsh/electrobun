import { describe, expect, test } from "bun:test";
import {
	cleanupKitchenLegacyManifests,
	KITCHEN_CANARY_TARGETS,
	parseCleanupArguments,
} from "./cleanup-kitchen-legacy-manifests";

const version = "2.0.7-beta.5";
const base = "https://electrobun-artifacts.blackboard.sh/kitchen";
const targets = ["macos-arm64", "macos-x64", "linux-arm64", "linux-x64", "win-arm64", "win-x64"];
const expectedDeletes = targets.map((target) => `kitchen/canary-${target}-update-v2.json`);
function manifest(target: string) {
	const [platform, arch] = target.split("-");
	return {
		schemaVersion: 1, identifier: "sh.blackboard.electrobun-kitchen", channel: "canary",
		version, hash: "2mk7i5wph5519", platform, arch,
		artifact: {
			file: `canary-${target}-ElectrobunKitchenSink-canary${platform === "macos" ? ".app" : ""}.tar.zst`,
			tarSha256: "a".repeat(64), tarSize: 4096,
		},
	};
}

function fixture(override?: (url: string, method: string) => Response | undefined) {
	const requests: { url: string; method: string }[] = [];
	const signed: string[] = [];
	const client = {
		presign(key: string, options: unknown) {
			expect(options).toEqual({ method: "DELETE", expiresIn: 60 });
			signed.push(key);
			return `https://r2.invalid/${key}`;
		},
	};
	const request = (async (input: string | URL | Request, options?: RequestInit) => {
		const url = String(input);
		const method = options?.method ?? "GET";
		requests.push({ url, method });
		expect(options?.signal).toBeInstanceOf(AbortSignal);
		expect(options?.redirect).toBe("error");
		const replacement = override?.(url, method);
		if (replacement) return replacement;
		if (method === "DELETE") return new Response(null, { status: 204 });
		expect(options?.cache).toBe("no-store");
		if (method === "HEAD") {
			return new Response(null, { headers: { "content-length": "1234" } });
		}
		const target = targets.find((target) => url === `${base}/canary-${target}-update.json`);
		if (!target) throw new Error(`Unexpected request ${url}`);
		return Response.json(manifest(target));
	}) as typeof fetch;
	return { requests, signed, dependencies: { fetch: request, client, log: () => {} } };
}

describe("Kitchen canary legacy manifest cleanup", () => {
	test("requires an exact version, defaults to dry-run, and rejects scope/ambiguous arguments", () => {
		expect(parseCleanupArguments([`--expected-version=${version}`])).toEqual({ expectedVersion: version, apply: false });
		expect(parseCleanupArguments([`--expected-version=${version}`, "--apply"]).apply).toBe(true);
		expect(parseCleanupArguments([`--expected-version=${version}`, "--dry-run"]).apply).toBe(false);
		for (const args of [[], ["--expected-version=latest"], ["--expected-version=../version"],
			[`--expected-version=${version}`, "--channel=stable"],
			[`--expected-version=${version}`, "--bucket=another-app"],
			[`--expected-version=${version}`, "--target=win-x64"],
			[`--expected-version=${version}`, "--apply", "--dry-run"],
			[`--expected-version=${version}`, `--expected-version=${version}`]]) {
			expect(() => parseCleanupArguments(args)).toThrow();
		}
	});

	test("dry-run checks every replacement without credentials or deletion", async () => {
		const f = fixture();
		const result = await cleanupKitchenLegacyManifests({ expectedVersion: version }, { ...f.dependencies, client: undefined });
		expect(KITCHEN_CANARY_TARGETS).toEqual(targets);
		expect(result).toEqual(expectedDeletes);
		expect(f.requests.map((r) => r.method)).toEqual(targets.flatMap(() => ["GET", "HEAD"]));
		expect(f.signed).toEqual([]);
	});

	test("apply verifies all six targets before deleting only their legacy canary manifests", async () => {
		const f = fixture();
		await cleanupKitchenLegacyManifests({ expectedVersion: version, apply: true }, f.dependencies);
		expect(f.requests.slice(0, 12).map((r) => r.method)).toEqual(targets.flatMap(() => ["GET", "HEAD"]));
		expect(f.requests.slice(12)).toEqual(expectedDeletes.map((key) => ({ url: `https://r2.invalid/${key}`, method: "DELETE" })));
		expect(f.signed).toEqual(expectedDeletes);
		// HEAD length is compressed (1234); the uncompressed tarSize is 4096.
		// Neither canonical manifests, payloads, patches nor stable objects are deleted.
		expect(f.signed.every((key) => /^kitchen\/canary-(macos|linux|win)-(arm64|x64)-update-v2\.json$/.test(key))).toBe(true);
	});

	test("wrong or missing metadata on the last platform prevents every deletion", async () => {
		const mutations = [
			(m: any) => { m.version = "2.0.6-beta.17"; },
			(m: any) => { m.channel = "stable"; },
			(m: any) => { m.identifier = "another.app"; },
			(m: any) => { m.schemaVersion = 2; },
			(m: any) => { m.platform = "macos"; },
			(m: any) => { m.arch = "arm64"; },
			(m: any) => { delete m.hash; },
			(m: any) => { m.hash = "bad_hash"; },
			(m: any) => { m.hash = "a".repeat(14); },
			(m: any) => { delete m.artifact; },
			(m: any) => { delete m.artifact.tarSha256; },
			(m: any) => { m.artifact.tarSha256 = "invalid"; },
			(m: any) => { delete m.artifact.tarSize; },
			(m: any) => { m.artifact.tarSize = 0; },
			(m: any) => { m.artifact.tarSize = Number.MAX_SAFE_INTEGER + 1; },
			...[
				"../stable-win-x64-update.json", "https://another.app/payload.tar.zst",
				"canary-win-x64-%2e%2e%2fpayload.tar.zst", "stable-win-x64-ElectrobunKitchenSink.tar.zst",
				"canary-macos-arm64-ElectrobunKitchenSink-canary.app.tar.zst",
			].map((file) => (m: any) => { m.artifact.file = file; }),
		];
		for (const mutate of mutations) {
			const f = fixture((url) => {
				if (url !== `${base}/canary-win-x64-update.json`) return;
				const document = manifest("win-x64");
				mutate(document);
				return Response.json(document);
			});
			await expect(cleanupKitchenLegacyManifests({ expectedVersion: version, apply: true }, f.dependencies)).rejects.toThrow("Canonical manifest win-x64");
			expect(f.signed).toEqual([]);
			expect(f.requests.filter((r) => r.method === "DELETE")).toEqual([]);
		}
	});

	test("missing, invalid, oversized, redirected, or unavailable canonical responses refuse deletion", async () => {
		for (const response of [
			() => new Response(null, { status: 404 }),
			() => new Response(null, { status: 503 }),
			() => new Response(null, { status: 302, headers: { location: "https://another.app" } }),
			() => new Response("not JSON"),
			() => new Response(" ".repeat(64 * 1024 + 1)),
		]) {
			const f = fixture((url) => url === `${base}/canary-win-x64-update.json` ? response() : undefined);
			await expect(cleanupKitchenLegacyManifests({ expectedVersion: version, apply: true }, f.dependencies)).rejects.toThrow();
			expect(f.signed).toEqual([]);
		}
	});

	test("missing or empty payload and request timeout refuse every deletion", async () => {
		for (const response of [
			() => new Response(null, { status: 404 }),
			() => new Response(null, { headers: { "content-length": "0" } }),
			() => { throw new DOMException("Timed out", "TimeoutError"); },
		]) {
			const f = fixture((url, method) => method === "HEAD" && url.includes("canary-win-x64-") ? response() : undefined);
			await expect(cleanupKitchenLegacyManifests({ expectedVersion: version, apply: true }, f.dependencies)).rejects.toThrow();
			expect(f.signed).toEqual([]);
		}
	});

	test("apply requires a client and stops reporting success when deletion fails", async () => {
		const f = fixture((_url, method) => method === "DELETE" ? new Response(null, { status: 403 }) : undefined);
		await expect(cleanupKitchenLegacyManifests({ expectedVersion: version, apply: true }, { ...f.dependencies, client: undefined })).rejects.toThrow("credentials");
		expect(f.requests).toHaveLength(0);
		await expect(cleanupKitchenLegacyManifests({ expectedVersion: version, apply: true }, f.dependencies)).rejects.toThrow("HTTP 403");
		expect(f.signed).toEqual(expectedDeletes.slice(0, 1));
	});
});
