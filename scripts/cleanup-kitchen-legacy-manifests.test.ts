import { describe, expect, test } from "bun:test";
import {
	cleanupKitchenLegacyManifests,
	KITCHEN_TARGETS,
	parseCleanupArguments,
} from "./cleanup-kitchen-legacy-manifests";

const version = "2.0.7-beta.5";
const base = "https://electrobun-artifacts.blackboard.sh/kitchen";
const targets = ["macos-arm64", "macos-x64", "linux-arm64", "linux-x64", "win-arm64", "win-x64"];
const expectedDeletes = targets.map((target) => `kitchen/canary-${target}-update-v2.json`);
type Channel = "canary" | "stable";
const publicChecks = (channel: Channel = "canary") => targets.map(target => ({ url: `${base}/${channel}-${target}-update-v2.json`, method: "GET" }));
function manifest(target: string, channel: Channel = "canary", expectedVersion = version) {
	const [platform, arch] = target.split("-");
	return {
		schemaVersion: 1, identifier: "sh.blackboard.electrobun-kitchen", channel,
		version: expectedVersion, hash: "2mk7i5wph5519", platform, arch,
		artifact: {
			file: `${channel}-${target}-ElectrobunKitchenSink${channel === "canary" ? "-canary" : ""}${platform === "macos" ? ".app" : ""}.tar.zst`,
			tarSha256: "a".repeat(64), tarSize: 4096,
		},
	};
}

function legacyManifest(target: string, channel: Channel = "canary", expectedVersion = version) {
	const document = manifest(target, channel, expectedVersion);
	return { ...document, artifact: { file: document.artifact.file } };
}

function fixture(override?: (url: string, method: string) => Response | undefined, sidecars: false | "fixed" | "legacy" = false,
	channel: Channel = "canary", expectedVersion = version) {
	const requests: { url: string; method: string }[] = [];
	const signed: string[] = [];
	const deleted = new Set<string>();
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
		if (method === "DELETE") {
			deleted.add(url.slice("https://r2.invalid/kitchen/".length));
			return new Response(null, { status: 204 });
		}
		expect(options?.cache).toBe("no-store");
		if (url.startsWith(`${base}/`) && url.endsWith("-update-v2.json")) {
			expect(deleted.has(url.slice(base.length + 1))).toBe(true);
			return new Response(null, { status: 404 });
		}
		if (method === "HEAD") {
			return new Response(null, { headers: { "content-length": "1234" } });
		}
		const fixedTarget = targets.find((target) => url === `${base}/${channel}-${target}-checksum.json`);
		if (sidecars && fixedTarget) {
			return sidecars === "legacy" ? new Response(null, { status: 404 })
				: Response.json({ hash: manifest(fixedTarget, channel, expectedVersion).hash, tarSha256: "a".repeat(64), tarSize: 4096 });
		}
		if (sidecars === "legacy" && targets.some((target) => url === `${base}/${channel}-${target}-${manifest(target, channel, expectedVersion).hash}-checksum.json`)) {
			return Response.json({ tarSha256: "a".repeat(64), tarSize: 4096 });
		}
		const target = targets.find((target) => url === `${base}/${channel}-${target}-update.json`);
		if (!target) throw new Error(`Unexpected request ${url}`);
		return Response.json(sidecars ? legacyManifest(target, channel, expectedVersion) : manifest(target, channel, expectedVersion));
	}) as typeof fetch;
	return { requests, signed, dependencies: { fetch: request, client, log: () => {} } };
}

describe("Kitchen legacy manifest cleanup", () => {
	test("requires an exact version, defaults to dry-run, and rejects scope/ambiguous arguments", () => {
		expect(parseCleanupArguments([`--expected-version=${version}`])).toEqual({ expectedVersion: version, channel: "canary", apply: false });
		expect(parseCleanupArguments(["--expected-version=2.0.7", "--channel=stable", "--apply"])).toEqual({ expectedVersion: "2.0.7", channel: "stable", apply: true });
		expect(parseCleanupArguments([`--expected-version=${version}`, "--channel=canary"])).toEqual({ expectedVersion: version, channel: "canary", apply: false });
		expect(parseCleanupArguments([`--expected-version=${version}`, "--apply"]).apply).toBe(true);
		expect(parseCleanupArguments([`--expected-version=${version}`, "--dry-run"]).apply).toBe(false);
		for (const args of [[], ["--expected-version=latest"], ["--expected-version=../version"],
			...["", "dev", "production", "../stable", "stable/canary", "STABLE"].map(channel => [`--expected-version=${version}`, `--channel=${channel}`]),
			[`--expected-version=${version}`, "--channel=stable", "--channel=stable"],
			[`--expected-version=${version}`, "--channel=stable", "--channel=canary"],
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
		expect(KITCHEN_TARGETS).toEqual(targets);
		expect(result).toEqual(expectedDeletes);
		expect(f.requests.map((r) => r.method)).toEqual(targets.flatMap(() => ["GET", "HEAD"]));
		expect(f.signed).toEqual([]);
	});

	test("apply verifies all six targets before deleting only their legacy canary manifests", async () => {
		const f = fixture();
		await cleanupKitchenLegacyManifests({ expectedVersion: version, apply: true }, f.dependencies);
		expect(f.requests.slice(0, 12).map((r) => r.method)).toEqual(targets.flatMap(() => ["GET", "HEAD"]));
		expect(f.requests.slice(12, 18)).toEqual(expectedDeletes.map((key) => ({ url: `https://r2.invalid/${key}`, method: "DELETE" })));
		expect(f.requests.slice(18)).toEqual(publicChecks());
		expect(f.signed).toEqual(expectedDeletes);
		// HEAD length is compressed (1234); the uncompressed tarSize is 4096.
		// Neither canonical manifests, payloads, patches nor stable objects are deleted.
		expect(f.signed.every((key) => /^kitchen\/canary-(macos|linux|win)-(arm64|x64)-update-v2\.json$/.test(key))).toBe(true);
	});

	test("fixed sidecar cleanup validates each target and exact body hash before signing any deletion", async () => {
		const f = fixture(undefined, "fixed");
		await cleanupKitchenLegacyManifests({ expectedVersion: version, apply: true }, f.dependencies);
		expect(f.requests.slice(0, 18)).toEqual(targets.flatMap((target) => [
			{ url: `${base}/canary-${target}-update.json`, method: "GET" },
			{ url: `${base}/canary-${target}-checksum.json`, method: "GET" },
			{ url: `${base}/${manifest(target).artifact.file}`, method: "HEAD" },
		]));
		expect(f.requests.slice(18, 24)).toEqual(expectedDeletes.map((key) => ({ url: `https://r2.invalid/${key}`, method: "DELETE" })));
		expect(f.requests.slice(24)).toEqual(publicChecks());
		expect(f.signed).toEqual(expectedDeletes);
	});

	test("stable cleanup verifies the six channel-prefixed archives before deleting only stable v2 manifests", async () => {
		const stableVersion = "2.0.7";
		const f = fixture(undefined, "fixed", "stable", stableVersion);
		const stableDeletes = targets.map(target => `kitchen/stable-${target}-update-v2.json`);
		const result = await cleanupKitchenLegacyManifests({ expectedVersion: stableVersion, channel: "stable", apply: true }, f.dependencies);
		expect(f.requests.slice(0, 18)).toEqual(targets.flatMap(target => [
			{ url: `${base}/stable-${target}-update.json`, method: "GET" },
			{ url: `${base}/stable-${target}-checksum.json`, method: "GET" },
			{ url: `${base}/stable-${target}-ElectrobunKitchenSink${target.startsWith("macos-") ? ".app" : ""}.tar.zst`, method: "HEAD" },
		]));
		expect(f.requests.slice(18, 24)).toEqual(stableDeletes.map(key => ({ url: `https://r2.invalid/${key}`, method: "DELETE" })));
		expect(f.requests.slice(24)).toEqual(publicChecks("stable"));
		expect(f.signed).toEqual(stableDeletes);
		expect(result).toEqual(stableDeletes);
		expect(f.requests.every(({ url }) => !url.includes("canary"))).toBe(true);
	});

	test("neither channel can use another channel's metadata or archive to authorize deletion", async () => {
		for (const channel of ["stable", "canary"] as const) {
			const other = channel === "stable" ? "canary" : "stable";
			for (const field of ["channel", "archive"] as const) {
				const f = fixture(url => {
					if (url !== `${base}/${channel}-win-x64-update.json`) return;
					const document = manifest("win-x64", channel);
					if (field === "channel") document.channel = other;
					else document.artifact.file = manifest("win-x64", other).artifact.file;
					return Response.json(document);
				}, false, channel);
				await expect(cleanupKitchenLegacyManifests({ expectedVersion: version, channel, apply: true }, f.dependencies)).rejects.toThrow("Canonical manifest win-x64");
				expect(f.signed).toEqual([]);
				expect(f.requests.some(({ method }) => method === "DELETE")).toBe(false);
			}
		}
	});

	test("the last stable target must have a matching checksum and an available archive before any deletion", async () => {
		for (const failure of ["checksum", "archive"] as const) {
			const f = fixture((url, method) => {
				if (failure === "checksum" && url === `${base}/stable-win-x64-checksum.json`) {
					return Response.json({ hash: "wrong123", tarSha256: "a".repeat(64), tarSize: 4096 });
				}
				if (failure === "archive" && method === "HEAD" && url.includes("stable-win-x64-")) return new Response(null, { status: 404 });
			}, "fixed", "stable", "2.0.7");
			await expect(cleanupKitchenLegacyManifests({ expectedVersion: "2.0.7", channel: "stable", apply: true }, f.dependencies)).rejects.toThrow();
			expect(f.signed).toEqual([]);
			expect(f.requests.some(({ method }) => method === "DELETE")).toBe(false);
		}
	});

	test("a successful origin deletion does not complete migration while any public legacy URL is not 404", async () => {
		for (const status of [200, 302, 403, 503]) {
			const logs: string[] = [];
			const f = fixture((url, method) => method === "GET" && url === `${base}/stable-win-x64-update-v2.json`
				? new Response(null, { status }) : undefined, "fixed", "stable", "2.0.7");
			await expect(cleanupKitchenLegacyManifests({ expectedVersion: "2.0.7", channel: "stable", apply: true },
				{ ...f.dependencies, log: message => logs.push(message) })).rejects.toThrow(`must return public HTTP 404 after deletion; received HTTP ${status}`);
			expect(f.signed).toEqual(targets.map(target => `kitchen/stable-${target}-update-v2.json`));
			expect(f.requests.slice(-6)).toEqual(publicChecks("stable"));
			expect(logs.some(message => message.startsWith("Verified all six"))).toBe(false);
		}
	});

	test("unsupported channels passed directly fail before any storage or network operation", async () => {
		for (const channel of ["", "production", "../stable", "stable/canary", null, 1]) {
			const f = fixture();
			await expect(cleanupKitchenLegacyManifests({ expectedVersion: version, channel: channel as any, apply: true }, f.dependencies)).rejects.toThrow("channel");
			expect(f.signed).toEqual([]);
			expect(f.requests).toEqual([]);
		}
	});

	test("legacy sidecars are accepted only after a fixed sidecar 404", async () => {
		const f = fixture(undefined, "legacy");
		await cleanupKitchenLegacyManifests({ expectedVersion: version, apply: true }, f.dependencies);
		expect(f.requests.slice(0, 24)).toEqual(targets.flatMap((target) => [
			{ url: `${base}/canary-${target}-update.json`, method: "GET" },
			{ url: `${base}/canary-${target}-checksum.json`, method: "GET" },
			{ url: `${base}/canary-${target}-${manifest(target).hash}-checksum.json`, method: "GET" },
			{ url: `${base}/${manifest(target).artifact.file}`, method: "HEAD" },
		]));
		expect(f.requests.slice(24, 30)).toEqual(expectedDeletes.map((key) => ({ url: `https://r2.invalid/${key}`, method: "DELETE" })));
		expect(f.requests.slice(30)).toEqual(publicChecks());
		expect(f.signed).toEqual(expectedDeletes);
	});

	test("sidecar dry-run validates replacements without signing deletions", async () => {
		const f = fixture(undefined, "fixed");
		await cleanupKitchenLegacyManifests({ expectedVersion: version }, { ...f.dependencies, client: undefined });
		expect(f.requests.map((r) => r.method)).toEqual(targets.flatMap(() => ["GET", "GET", "HEAD"]));
		expect(f.signed).toEqual([]);
	});

	test("invalid, redirected, oversized, or unavailable fixed checksum prevents all deletion without a legacy fallback", async () => {
		const checksumUrl = `${base}/canary-win-x64-checksum.json`;
		const hash = manifest("win-x64").hash;
		for (const response of [
			() => new Response(null, { status: 503 }),
			() => new Response(null, { status: 302, headers: { location: "https://another.app/checksum.json" } }),
			() => new Response(null),
			() => new Response("not JSON"),
			() => new Response(" ".repeat(64 * 1024 + 1)),
			() => { throw new DOMException("Timed out", "TimeoutError"); },
			...[null, [], {}, { hash, tarSha256: "a".repeat(64) }, { hash, tarSize: 4096 },
				{ tarSha256: "a".repeat(64), tarSize: 4096 },
				...[null, 42, "wrong123", "bad_hash"].map((hash) => ({ hash, tarSha256: "a".repeat(64), tarSize: 4096 })),
				{ hash, tarSha256: "invalid", tarSize: 4096 },
				{ hash, tarSha256: "a".repeat(64), tarSize: 0 },
				{ hash, tarSha256: "a".repeat(64), tarSize: Number.MAX_SAFE_INTEGER + 1 },
				{ hash, tarSha256: "a".repeat(64), tarSize: "4096" },
			].map((body) => () => Response.json(body)),
		]) {
			const f = fixture((url) => url === checksumUrl ? response() : undefined, "fixed");
			await expect(cleanupKitchenLegacyManifests({ expectedVersion: version, apply: true }, f.dependencies)).rejects.toThrow();
			expect(f.requests.some((r) => r.url.endsWith(`-${manifest("win-x64").hash}-checksum.json`))).toBe(false);
			expect(f.signed).toEqual([]);
			expect(f.requests.filter((r) => r.method === "DELETE")).toEqual([]);
		}
	});

	test("missing or invalid legacy sidecar and invalid optional legacy hash prevent every deletion", async () => {
		const checksumUrl = `${base}/canary-win-x64-${manifest("win-x64").hash}-checksum.json`;
		for (const response of [
			() => new Response(null, { status: 404 }),
			() => new Response(null, { status: 503 }),
			...[null, 42, "wrong123", "bad_hash"].map((hash) => () =>
				Response.json({ hash, tarSha256: "a".repeat(64), tarSize: 4096 })),
			...[{}, { tarSize: 4096 }, { tarSha256: "invalid", tarSize: 4096 },
				{ tarSha256: "a".repeat(64), tarSize: 0 },
				{ tarSha256: "a".repeat(64), tarSize: "4096" },
			].map((body) => () => Response.json(body)),
		]) {
			const f = fixture((url) => url === checksumUrl ? response() : undefined, "legacy");
			await expect(cleanupKitchenLegacyManifests({ expectedVersion: version, apply: true }, f.dependencies)).rejects.toThrow();
			expect(f.requests.slice(-2)).toEqual([
				{ url: `${base}/canary-win-x64-checksum.json`, method: "GET" },
				{ url: checksumUrl, method: "GET" },
			]);
			expect(f.signed).toEqual([]);
			expect(f.requests.filter((r) => r.method === "DELETE")).toEqual([]);
		}
	});

	test("legacy sidecars may include a matching body hash", async () => {
		const f = fixture((url) => url.endsWith(`-${manifest("win-x64").hash}-checksum.json`)
			? Response.json({ hash: manifest("win-x64").hash, tarSha256: "a".repeat(64), tarSize: 4096 }) : undefined, "legacy");
		await cleanupKitchenLegacyManifests({ expectedVersion: version, apply: true }, f.dependencies);
		expect(f.signed).toEqual(expectedDeletes);
	});

	test("a valid sidecar cannot hide partial or invalid inline integrity", async () => {
		for (const integrity of [
			{ tarSha256: "a".repeat(64) }, { tarSize: 4096 },
			{ tarSha256: "invalid", tarSize: 4096 },
		]) {
			const f = fixture((url) => {
				if (url !== `${base}/canary-win-x64-update.json`) return;
				const document = legacyManifest("win-x64");
				return Response.json({ ...document, artifact: { ...document.artifact, ...integrity } });
			}, "fixed");
			await expect(cleanupKitchenLegacyManifests({ expectedVersion: version, apply: true }, f.dependencies)).rejects.toThrow("Canonical manifest win-x64");
			expect(f.requests.some((r) => r.url.endsWith("canary-win-x64-checksum.json"))).toBe(false);
			expect(f.signed).toEqual([]);
			expect(f.requests.filter((r) => r.method === "DELETE")).toEqual([]);
		}
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

	test("failed signed deletion never surfaces provider errors containing credentials", async () => {
		const f = fixture((_url, method) => {
			if (method === "DELETE") throw new Error("https://r2.invalid/?X-Amz-Credential=private-credential");
		});
		await expect(cleanupKitchenLegacyManifests({ expectedVersion: version, apply: true }, f.dependencies))
			.rejects.toThrow(`R2 deletion request failed for ${expectedDeletes[0]}`);
		expect(f.signed).toEqual(expectedDeletes.slice(0, 1));
	});
});
