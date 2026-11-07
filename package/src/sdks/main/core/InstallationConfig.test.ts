import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInstallationClient, resolveInstallationConfiguration, validateInstallationConfig } from "./InstallationConfig";

describe("shared installation identity", () => {
	const storagePath = "/profile/insights";
	const id = "0123456789abcdef0123456789abcdef";

	test("ordinary apps can retrieve a local ID without any cloud service configuration", () => {
		expect(resolveInstallationConfiguration({}, {}, storagePath)).toEqual({ storagePath });
	});

	test("hosting-only identity and disabled Insights retain the existing local storage location", () => {
		const managed = { appId: "app-example" };
		const expected = { appId: managed.appId, storagePath };
		expect(resolveInstallationConfiguration({}, { managed }, storagePath)).toEqual(expected);
		for (const enabled of [undefined, false, true]) {
			expect(resolveInstallationConfiguration({ insights: { ...managed, enabled } }, { managed }, storagePath)).toEqual(expected);
		}
	});

	test("rejects conflicting cloud app IDs and invalid migration hints", () => {
		expect(() => resolveInstallationConfiguration({ insights: { appId: "one" } }, { managed: { appId: "two" } }, storagePath)).toThrow();
		for (const appId of ["", "../app", "app/other", "a".repeat(129)]) {
			expect(() => validateInstallationConfig({ appId, storagePath })).toThrow();
		}
		expect(() => validateInstallationConfig({ storagePath: "" })).toThrow();
		expect(() => validateInstallationConfig({ storagePath: "profile\0other" })).toThrow();
	});

	test("getter configures local identity lazily with no reporter or collection settings", () => {
		const configurations: unknown[] = [];
		const client = createInstallationClient({
			loadConfiguration: () => resolveInstallationConfiguration({}, {}, storagePath),
			configure: (json) => { configurations.push(JSON.parse(json)); return true; },
			getId: () => id,
		});
		expect(configurations).toEqual([]);
		expect(client.getId()).toBe(id);
		expect(client.getId()).toBe(id);
		expect(configurations).toEqual([{ storagePath }]);
	});

	test("unavailable core or failed storage never produces an unrelated SDK-generated ID", () => {
		let reads = 0;
		const client = createInstallationClient({
			loadConfiguration: () => ({ storagePath }), configure: () => false,
			getId: () => { reads++; return id; },
		});
		expect(client.getId()).toBeNull();
		expect(reads).toBe(0);
	});

	test("transient local failure can retry, and malformed native IDs are rejected", () => {
		let available = false;
		let nativeId = "bad-id";
		const client = createInstallationClient({
			loadConfiguration: () => ({ storagePath }), configure: () => available,
			getId: () => nativeId,
		});
		expect(client.getId()).toBeNull();
		available = true;
		expect(client.getId()).toBeNull();
		nativeId = id;
		expect(client.getId()).toBe(id);
	});

	test("the main entry exposes local identity through app without a separate public namespace", () => {
		const modulePath = (relative: string) => JSON.stringify(fileURLToPath(new URL(relative, import.meta.url)));
		// Isolate the native-free fixture from other updater tests. Only window
		// initialization is stubbed; the real main entry and identity client run.
		const script = `
import assert from "node:assert/strict";
import { mock } from "bun:test";
mock.module(${modulePath("./BrowserWindow.ts")}, () => ({ BrowserWindow: class {}, BrowserWindowMap: new Map() }));
mock.module(${modulePath("./GpuWindow.ts")}, () => ({ GpuWindow: class {}, GpuWindowMap: new Map() }));
const { installationNative } = await import(${modulePath("../proc/installationNative.ts")});
const { insightsNative } = await import(${modulePath("../proc/insightsNative.ts")});
const configured = [];
installationNative.configure = json => { configured.push(JSON.parse(json)); return true; };
installationNative.getInstallationId = () => ${JSON.stringify(id)};
insightsNative.configure = () => { throw new Error("Reading identity must not configure Insights"); };
globalThis.fetch = () => { throw new Error("Reading identity must not make a request"); };
const api = await import(${modulePath("../index.ts")});
assert.equal(api.app, api.default.app);
assert.equal("Installation" in api, false);
assert.equal("Installation" in api.default, false);
assert.equal(configured.length, 0, "Importing the SDK does not initialize identity");
assert.equal(api.app.getInstallationId(), ${JSON.stringify(id)});
assert.equal(api.default.app.getInstallationId(), ${JSON.stringify(id)});
assert.equal(configured.length, 1, "Both public access paths share one lazy local identity client");
assert.deepEqual(Object.keys(configured[0]), ["storagePath"]);
assert.equal(typeof configured[0].storagePath, "string");
`;
		const directory = mkdtempSync(join(tmpdir(), "electrobun-app-identity-"));
		try {
			mkdirSync(join(directory, "Resources"));
			mkdirSync(join(directory, "bin"));
			writeFileSync(join(directory, "Resources/version.json"), JSON.stringify({
				identifier: "dev.example.identity", channel: "stable", name: "Identity", version: "1.0.0", hash: "example",
			}));
			const result = spawnSync(process.execPath, ["-e", script], {
				cwd: join(directory, "bin"), encoding: "utf8", timeout: 20_000,
			});
			expect(result.error).toBeUndefined();
			expect(result.stdout + result.stderr).toBe("");
			expect(result.status).toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
