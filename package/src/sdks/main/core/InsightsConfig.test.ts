import { describe, expect, test } from "bun:test";
import { resolveInsightsConfiguration, serializeInsightsProperties, validInsightsEventName } from "./InsightsConfig";

describe("Insights runtime configuration", () => {
	const publicConfig = { appId: "app-example", apiUrl: "https://api.example.com" };
	const resolve = (channel: string | undefined, enabled?: boolean) =>
		resolveInsightsConfiguration({ ...publicConfig, enabled }, { channel, version: "1.2.3", hash: "build123" }, "/profile/insights", "linux", "arm64");

	test("an app ID uses the shared hosted service without endpoint configuration", () => {
		const resolved = resolveInsightsConfiguration({ appId: "app-example" }, {
			channel: "stable", version: "1.2.3", hash: "build123",
		}, "/profile/insights", "macos", "arm64");
		expect(resolved).toMatchObject({ appId: "app-example", apiUrl: "https://api.electrobun.dev", enabled: false });
		expect(resolve("stable").apiUrl).toBe(publicConfig.apiUrl);
	});

	test("every channel requires explicit collection opt-in even with an app ID", () => {
		expect(resolve(undefined).enabled).toBe(false);
		expect(resolve("dev").enabled).toBe(false);
		const localDev = resolveInsightsConfiguration(
			{ ...publicConfig, apiUrl: "http://127.0.0.1:8787", enabled: true },
			{ channel: "dev", version: "1.2.3", hash: "build123" }, "/profile/insights", "linux", "arm64",
		);
		expect(localDev.enabled).toBe(true);
		expect(resolve("canary").enabled).toBe(false);
		expect(resolve("stable").enabled).toBe(false);
		expect(resolve("canary", true).enabled).toBe(true);
		expect(resolve("stable", true).enabled).toBe(true);
		expect(resolve("stable", false).enabled).toBe(false);
	});

	test("matching managed custom origin receives Insights without enabling collection", () => {
		const resolved = resolveInsightsConfiguration({ appId: "app-example" }, {
			channel: "stable", version: "1.2.3", hash: "build123",
			managed: { appId: "app-example", baseUrl: "https://updates.example.com/" },
		}, "/profile/insights", "macos", "arm64");
		expect(resolved).toMatchObject({ appId: "app-example", apiUrl: "https://updates.example.com", enabled: false,
			version: "1.2.3", buildHash: "build123", channel: "stable" });
	});

	test("explicit Insights endpoint overrides managed custom domain inheritance", () => {
		const resolved = resolveInsightsConfiguration(publicConfig, {
			channel: "stable", managed: { appId: "another-app", baseUrl: "https://updates.example.com" },
		}, "/profile/insights", "macos", "arm64");
		expect(resolved.apiUrl).toBe(publicConfig.apiUrl);
	});

	test("ordinary static release URLs never redirect Insights", () => {
		const version = { channel: "stable", baseUrl: "https://static.example.com/app/releases" };
		const resolved = resolveInsightsConfiguration({ appId: "app-example" }, version, "/profile/insights", "macos", "arm64");
		expect(resolved.apiUrl).toBe("https://api.electrobun.dev");
	});

	test("custom domain inheritance refuses another app or a URL folder", () => {
		const resolveManaged = (appId: string, baseUrl: string) => resolveInsightsConfiguration({ appId: "app-example" }, {
			channel: "stable", managed: { appId, baseUrl },
		}, "/profile/insights", "macos", "arm64");
		expect(() => resolveManaged("another-app", "https://updates.example.com")).toThrow("different managed app");
		for (const origin of [
			"https://updates.example.com/releases", "https://updates.example.com?channel=stable", "https://updates.example.com?",
			"https://updates.example.com#fragment", "https://user:password@updates.example.com", "http://updates.example.com",
			"https://updates.example.com////", "https://updates.example.com:8443",
		]) expect(() => resolveManaged("app-example", origin)).toThrow();
		expect(resolveManaged("app-example", "https://updates.example.com:443/").apiUrl).toBe("https://updates.example.com");
		expect(resolveManaged("app-example", "http://127.0.0.1:8787/").apiUrl).toBe("http://127.0.0.1:8787");
	});

	test("Insights stays enabled when updates belong to an external authority", () => {
		const resolved = resolveInsightsConfiguration({ ...publicConfig, enabled: true }, {
			version: "1.2.3", hash: "build123", channel: "stable", updateAuthority: "external", distribution: "app-store",
		}, "/profile/insights", "macos", "arm64");
		expect(resolved).toMatchObject({ enabled: true, updateAuthority: "external", distribution: "app-store", version: "1.2.3", buildHash: "build123", storagePath: "/profile/insights" });
		expect(resolved).not.toHaveProperty("apiKey");
	});
});

describe("Insights event limits", () => {
	test("rejects names and property keys the ingestion endpoint cannot accept", () => {
		expect(validInsightsEventName("export.completed: PDF-2")).toBe(true);
		expect(validInsightsEventName(" export")).toBe(false);
		expect(validInsightsEventName("export/complete")).toBe(false);
		expect(validInsightsEventName("x".repeat(81))).toBe(false);
		expect(serializeInsightsProperties({ "space key": "value" })).toBeNull();
		expect(serializeInsightsProperties({ ["x".repeat(65)]: "value" })).toBeNull();
	});
	test("accepts flat scalar properties, including false and zero", () => {
		expect(JSON.parse(serializeInsightsProperties({ screen: "editor", count: 0, enabled: false, optional: null })!)).toEqual({ screen: "editor", count: 0, enabled: false, optional: null });
	});

	test("rejects nested values, non-finite numbers and oversized values", () => {
		expect(serializeInsightsProperties({ nested: { value: true } } as never)).toBeNull();
		expect(serializeInsightsProperties({ value: NaN })).toBeNull();
		expect(serializeInsightsProperties({ value: Infinity })).toBeNull();
		expect(serializeInsightsProperties({ value: "x".repeat(257) })).toBeNull();
		expect(serializeInsightsProperties(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`key${i}`, i])))).toBeNull();
	});
});
