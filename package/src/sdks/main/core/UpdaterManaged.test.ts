import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { getPatchFileUrl, getPlatformPrefix } from "../../../shared/naming";
import { ARCH, OS } from "../../../shared/platform";
import { Updater, buildUpdateArtifactUrl, managedUpdateApiBase, managedUpdateBaseUrl, resolveUpdateManifest, type LocalUpdateInfo } from "./Updater";
import { Installation } from "./Installation";

const installationId = "0123456789abcdef0123456789abcdef";
let installationSpy: ReturnType<typeof spyOn<typeof Installation, "getId">>;
beforeEach(() => { installationSpy = spyOn(Installation, "getId").mockReturnValue(installationId); });
afterEach(() => { installationSpy.mockRestore(); });

const info: LocalUpdateInfo = {
	identifier: "com.example.application", channel: "stable", version: "1.0.0",
	hash: "old123", name: "Example", baseUrl: "https://updates.example.test/canonical",
};
const manifest = {
	schemaVersion: 1 as const, identifier: info.identifier, channel: info.channel,
	version: "2.0.0", hash: "new123", platform: OS, arch: ARCH,
	artifact: { file: `stable-${OS}-${ARCH}-Example.tar.zst`, tarSha256: "a".repeat(64), tarSize: 2048 },
};
const managed = { appId: "app_test", apiUrl: "https://api.example.test" };
const managedBase = "https://api.example.test/v1/electrobun/apps/app_test/updates";
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe("flat managed update folder", () => {
	test("an app ID derives a fixed updates folder without a release resolver", async () => {
		const selected = await resolveUpdateManifest({ ...info, managed: { appId: "app_test" } }, {
			fetchResponse: async (input, init) => {
				const url = new URL(input);
				expect(url.origin).toBe("https://api.electrobun.dev");
				expect(url.pathname).toBe(`/v1/electrobun/apps/app_test/updates/stable-${OS}-${ARCH}-update.json`);
				expect(url.search).toMatch(/^\?[a-f0-9]{16}$/);
				expect(init.redirect).toBe("manual");
				expect(new Headers(init.headers).get("X-Electrobun-Installation-Id")).toBe(installationId);
				return reply(manifest);
			},
		});
		expect(selected).toEqual({ status: "available", manifest,
			downloadBaseUrl: "https://api.electrobun.dev/v1/electrobun/apps/app_test/updates" });
	});

	test("normalizes the configured API root without changing embedded app identity", async () => {
		for (const apiUrl of [managed.apiUrl, `${managed.apiUrl}/`, `${managed.apiUrl}/v1/electrobun/`]) {
			expect(managedUpdateApiBase(apiUrl)).toBe(`${managed.apiUrl}/v1/electrobun`);
			expect(managedUpdateBaseUrl({ ...managed, apiUrl })).toBe(managedBase);
			const local = { ...info, managed: { ...managed, apiUrl } };
			const selected = await resolveUpdateManifest(local, { fetchResponse: async (input) => {
				expect(new URL(input).pathname).toBe(`/v1/electrobun/apps/app_test/updates/stable-${OS}-${ARCH}-update.json`);
				return reply(manifest);
			} });
			expect(selected).toEqual({ status: "available", manifest, downloadBaseUrl: managedBase });
			expect(local.baseUrl).toBe(info.baseUrl);
		}
	});

	test("an explicit API override keeps the canonical app-scoped folder", async () => {
		const local = { ...info, managed: { appId: "app_test", apiUrl: "https://updates.customer.test/v1/electrobun/" } };
		const result = await resolveUpdateManifest(local, { fetchResponse: async (input) => {
			expect(new URL(input).origin).toBe("https://updates.customer.test");
			expect(new URL(input).pathname).toBe(`/v1/electrobun/apps/app_test/updates/stable-${OS}-${ARCH}-update.json`);
			return reply(manifest);
		} });
		expect(result).toEqual({ status: "available", manifest,
			downloadBaseUrl: "https://updates.customer.test/v1/electrobun/apps/app_test/updates" });
	});

	test("a custom managed origin serves ordinary filenames at its root", async () => {
		for (const baseUrl of ["https://updates.customer.test", "https://updates.customer.test/"]) {
			const local = { ...info, managed: { ...managed, baseUrl } };
			const result = await resolveUpdateManifest(local, { fetchResponse: async (input, init) => {
				const url = new URL(input);
				expect(url.origin).toBe("https://updates.customer.test");
				expect(url.pathname).toBe(`/stable-${OS}-${ARCH}-update.json`);
				expect(new Headers(init.headers).get("X-Electrobun-Installation-Id")).toBe(installationId);
				return reply(manifest);
			} });
			expect(result).toEqual({ status: "available", manifest, downloadBaseUrl: "https://updates.customer.test" });
			expect(managedUpdateBaseUrl(local.managed)).toBe("https://updates.customer.test");
			expect(getPatchFileUrl("https://updates.customer.test", `stable-${OS}-${ARCH}`, "old123"))
				.toBe(`https://updates.customer.test/stable-${OS}-${ARCH}-old123.patch`);
		}
	});

	test("rejects malformed app or API configuration before contacting any server", async () => {
		for (const configured of [
			{ ...managed, appId: "../other" },
			{ ...managed, appId: "app%2fother" },
			{ ...managed, apiUrl: "https://api.example.test/custom/prefix" },
			{ ...managed, apiUrl: "https://user:password@api.example.test" },
			{ ...managed, apiUrl: "https://api.example.test?candidate=1" },
			{ ...managed, apiUrl: "http://api.example.test" },
			{ ...managed, baseUrl: "https://updates.customer.test/another-app" },
			{ ...managed, baseUrl: "https://updates.customer.test/../" },
			{ ...managed, baseUrl: "https://updates.customer.test/%2e" },
			{ ...managed, baseUrl: "https://updates.customer.test\\" },
			{ ...managed, baseUrl: " https://updates.customer.test " },
			{ ...managed, baseUrl: "https://@updates.customer.test" },
			{ ...managed, baseUrl: "https://%75pdates.customer.test" },
			{ ...managed, baseUrl: "http://127.1:1234" },
			{ ...managed, baseUrl: "https://user:password@updates.customer.test" },
			{ ...managed, baseUrl: "https://updates.customer.test?app=other" },
			{ ...managed, baseUrl: "https://updates.customer.test#other" },
			{ ...managed, baseUrl: "http://updates.customer.test" },
			{ ...managed, baseUrl: "https://updates.customer.test", appId: "../other" },
		]) {
			let requests = 0;
			await expect(resolveUpdateManifest({ ...info, managed: configured }, { fetchResponse: async () => {
				requests++;
				return reply(manifest);
			} })).rejects.toThrow();
			expect(requests).toBe(0);
		}
	});

	test("does not accept a release-selection envelope in place of update.json", async () => {
		await expect(resolveUpdateManifest({ ...info, managed }, { fetchResponse: async () => reply({
			status: "available", releaseId: "release_test", manifest,
			downloadBaseUrl: `${managed.apiUrl}/v1/electrobun/apps/app_test/releases/release_test/artifacts`,
		}) })).rejects.toThrow();
	});

	test("requires a valid persisted identity before making managed requests", async () => {
		for (const id of [null, "", "not-an-install", "A".repeat(32), "a".repeat(31), "a".repeat(33)]) {
			installationSpy.mockReturnValue(id);
			let requests = 0;
			await expect(resolveUpdateManifest({ ...info, managed }, { fetchResponse: async () => {
				requests++;
				return reply(manifest);
			} })).rejects.toThrow("persisted installation ID");
			expect(requests).toBe(0);
		}
	});

	test("rejects a managed HTTPS redirect downgrade before contacting the destination", async () => {
		const urls: string[] = [];
		await expect(resolveUpdateManifest({ ...info, managed }, { fetchResponse: async (url) => {
			urls.push(url);
			return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1:1234/update.json" } });
		} })).rejects.toThrow("cannot downgrade HTTPS");
		expect(urls).toHaveLength(1);
	});

	test("keeps the install ID on custom-origin redirects without enabling Insights", async () => {
		const ids: (string | null)[] = [];
		const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
			ids.push(request.headers.get("X-Electrobun-Installation-Id"));
			if (new URL(request.url).pathname.endsWith("-update.json")) {
				return new Response(null, { status: 307, headers: { Location: "/redirected-manifest" } });
			}
			return reply(manifest);
		} });
		try {
			const selected = await resolveUpdateManifest({ ...info, managed: { ...managed, baseUrl: server.url.origin } });
			expect(selected.status).toBe("available");
			expect(ids).toEqual([installationId, installationId]);
		} finally { await server.stop(true); }
	});

	test("does not restore the ID after a redirect leaves and returns to the managed origin", async () => {
		const ids: (string | null)[] = [];
		let originalOrigin = "";
		const outside = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
			ids.push(request.headers.get("X-Electrobun-Installation-Id"));
			return new Response(null, { status: 302, headers: { Location: `${originalOrigin}/returned-manifest` } });
		} });
		const original = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
			ids.push(request.headers.get("X-Electrobun-Installation-Id"));
			return new URL(request.url).pathname === "/returned-manifest" ? reply(manifest)
				: new Response(null, { status: 302, headers: { Location: `${outside.url.origin}/redirect` } });
		} });
		originalOrigin = original.url.origin;
		try {
			expect((await resolveUpdateManifest({ ...info, managed: { ...managed, baseUrl: originalOrigin } })).status).toBe("available");
			expect(ids).toEqual([installationId, null, null]);
		} finally {
			await original.stop(true);
			await outside.stop(true);
		}
	});
});

describe("shared single-folder update contract", () => {
	for (const hosting of ["self-hosted", "managed"] as const) {
		const local: LocalUpdateInfo = hosting === "managed" ? { ...info, managed } : info;
		const base = hosting === "managed" ? managedBase : info.baseUrl;

		for (const changedHash of [false, true]) {
			test(`${hosting} public checkForUpdate ${changedHash ? "offers a new hash with the same semver" : "reports the current hash as up to date"}`, async () => {
				const originalLocalInfo = Updater.getLocalInfo;
				const originalFetch = globalThis.fetch;
				const next = { ...manifest, version: local.version,
					hash: changedHash ? "rebuilt456" : local.hash,
					artifact: { file: manifest.artifact.file } };
				const urls: string[] = [];
				try {
					Updater.getLocalInfo = async () => local;
					globalThis.fetch = (async (input: string | URL | Request) => {
						urls.push(String(input));
						return reply(next);
					}) as typeof fetch;
					const result = await Updater.checkForUpdate();
					expect(result).toMatchObject({
						version: local.version, hash: next.hash, error: "",
						updateAvailable: changedHash, updateReady: false,
					});
					expect(Updater.updateInfo()).toEqual(result);
					expect(urls).toHaveLength(1);
					expect(new URL(urls[0]!).pathname).toBe(`${new URL(base).pathname}/stable-${OS}-${ARCH}-update.json`);
					expect(new URL(urls[0]!).search).toMatch(/^\?[a-f0-9]{16}$/);
				} finally {
					Updater.getLocalInfo = originalLocalInfo;
					globalThis.fetch = originalFetch;
				}
			});
		}

		for (const channel of ["stable", "canary"] as const) {
			for (const integrity of [false, true]) {
				test(`${hosting} ${channel} ${integrity ? "modern" : "older"} metadata uses only the ordinary flat filenames`, async () => {
					const prefix = getPlatformPrefix(channel, OS, ARCH);
					const document = { ...manifest, channel,
						artifact: { file: `${prefix}-Example.tar.zst`,
							...(integrity ? { tarSha256: "a".repeat(64), tarSize: 2048 } : {}) } };
					const requested: string[] = [];
					const result = await resolveUpdateManifest({ ...local, channel }, { fetchResponse: async (input) => {
						requested.push(input);
						return reply(document);
					} });
					expect(requested).toHaveLength(1);
					expect(new URL(requested[0]!).pathname).toBe(`${new URL(base).pathname}/${prefix}-update.json`);
					expect(new URL(requested[0]!).search).toMatch(/^\?[a-f0-9]{16}$/);
					expect(result).toEqual({ status: "available", manifest: document,
						...(hosting === "managed" ? { downloadBaseUrl: base } : {}) });
					if (result.status !== "available") throw new Error("Expected ordinary manifest");
					const downloads = result.downloadBaseUrl ?? local.baseUrl;
					expect(getPatchFileUrl(downloads, prefix, "old123")).toBe(`${base}/${prefix}-old123.patch`);
					expect(getPatchFileUrl(downloads, prefix, "middle456")).toBe(`${base}/${prefix}-middle456.patch`);
					expect(buildUpdateArtifactUrl(downloads, result.manifest.artifact.file)).toBe(`${base}/${prefix}-Example.tar.zst`);
					expect(result).not.toHaveProperty("releaseId");
					expect(result).not.toHaveProperty("releaseNotesUrl");
				});
			}
		}

		test(`${hosting} missing update.json makes one request without a v2 probe or alternate host`, async () => {
			const urls: string[] = [];
			await expect(resolveUpdateManifest(local, { fetchResponse: async (input) => {
				urls.push(input);
				return reply({ error: "missing" }, 404);
			} })).rejects.toThrow("HTTP 404");
			expect(urls).toHaveLength(1);
			expect(urls[0]).toStartWith(`${base}/stable-${OS}-${ARCH}-update.json?`);
		});

		test(`${hosting} invalid manifest identity cannot change download authority`, async () => {
			for (const document of [
				{ ...manifest, identifier: "com.other.application" },
				{ ...manifest, channel: "canary" },
				{ ...manifest, artifact: { file: "../other/Example.tar.zst" } },
			]) {
				await expect(resolveUpdateManifest(local, { fetchResponse: async () => reply(document) })).rejects.toThrow();
			}
		});

		test(`${hosting} a new hash remains an update without a semver increase`, async () => {
			const sameVersion = { ...manifest, version: local.version };
			const result = await resolveUpdateManifest(local, { fetchResponse: async () => reply(sameVersion) });
			expect(result.status).toBe("available");
			if (result.status !== "available") throw new Error("Expected ordinary manifest");
			expect(result.manifest.version).toBe(local.version);
			expect(result.manifest.hash).not.toBe(local.hash);
		});

		test(`${hosting} external stores, disabled updates, and dev builds make no request`, async () => {
			for (const disabled of [
				{ ...local, updateAuthority: "external" as const },
				{ ...local, updateAuthority: "none" as const },
				{ ...local, channel: "dev" },
			]) {
				expect(await resolveUpdateManifest(disabled, { fetchResponse: async () => { throw new Error("network called"); } })).toEqual({ status: "disabled" });
			}
		});

		test(`${hosting} preserves ordinary manifest redirects`, async () => {
			const paths: string[] = [];
			const ids: (string | null)[] = [];
			const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
				paths.push(new URL(request.url).pathname);
				ids.push(request.headers.get("X-Electrobun-Installation-Id"));
				return reply(manifest);
			} });
			const source = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
				const url = new URL(request.url);
				paths.push(url.pathname);
				ids.push(request.headers.get("X-Electrobun-Installation-Id"));
				return new Response(null, { status: 302, headers: { Location: new URL(`/cdn/stable-${OS}-${ARCH}-update.json`, target.url).href } });
			} });
			try {
				const requestInfo = hosting === "managed"
					? { ...info, managed: { ...managed, apiUrl: source.url.origin } }
					: { ...info, baseUrl: `${source.url.origin}/nested/folder` };
				const result = await resolveUpdateManifest(requestInfo);
				expect(result.status).toBe("available");
				expect(paths).toEqual([
					`${hosting === "managed" ? "/v1/electrobun/apps/app_test/updates" : "/nested/folder"}/stable-${OS}-${ARCH}-update.json`,
					`/cdn/stable-${OS}-${ARCH}-update.json`,
				]);
				expect(ids).toEqual([hosting === "managed" ? installationId : null, null]);
				if (result.status !== "available") throw new Error("Expected ordinary manifest");
				expect(result.downloadBaseUrl ?? requestInfo.baseUrl).toStartWith(source.url.origin);
			} finally {
				await source.stop(true);
				await target.stop(true);
			}
		});
	}

	test("self-hosted nested and trailing-slash folders remain unchanged by managed resolution", async () => {
		await resolveUpdateManifest({ ...info, managed }, { fetchResponse: async () => reply(manifest) });
		for (const baseUrl of ["https://bucket.example.test", "https://bucket.example.test/apps/my-app/", "https://bucket.example.test/a%20folder/releases///"]) {
			const result = await resolveUpdateManifest({ ...info, baseUrl }, { fetchResponse: async (input) => {
				expect(input).toStartWith(`${baseUrl.replace(/\/+$/, "")}/stable-${OS}-${ARCH}-update.json?`);
				return reply(manifest);
			} });
			expect(result).toEqual({ status: "available", manifest });
		}
	});

	test("self-hosted updates never consult or transmit the installation ID", async () => {
		installationSpy.mockImplementation(() => { throw new Error("identity must not be read"); });
		const result = await resolveUpdateManifest(info, { fetchResponse: async (_input, init) => {
			expect(init.redirect).toBeUndefined();
			expect(new Headers(init.headers).has("X-Electrobun-Installation-Id")).toBe(false);
			return reply(manifest);
		} });
		expect(result).toEqual({ status: "available", manifest });
	});
});
