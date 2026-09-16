import { describe, expect, it } from "bun:test";
import {
	assertNoLegacyBunVersionConfig,
	assertValidVersionPins,
} from "./validate";

describe("assertNoLegacyBunVersionConfig", () => {
	it("accepts Bun, Cottontail, and native main-process configurations", () => {
		expect(() =>
			assertNoLegacyBunVersionConfig({
				build: {
					mainProcess: "cottontail",
					cottontail: { entrypoint: "src/bun/index.ts" },
				},
			}),
		).not.toThrow();
		expect(() =>
			assertNoLegacyBunVersionConfig({
				build: { mainProcess: "zig" },
			}),
		).not.toThrow();
		expect(() =>
			assertNoLegacyBunVersionConfig({
				build: {
					mainProcess: "bun",
					bun: { entrypoint: "src/bun/index.ts" },
				},
			}),
		).not.toThrow();
	});

	it.each([
		{ bunVersion: "1.3.8" },
		{ bunnyBun: "bunny-bun-test" },
	])("rejects unsupported per-project Bun version configuration: %p", (build) => {
		expect(() => assertNoLegacyBunVersionConfig({ build })).toThrow(
			"one pinned Bun runtime version",
		);
	});
});

describe("assertValidVersionPins", () => {
	it("accepts exact native toolchain versions", () => {
		expect(() =>
			assertValidVersionPins({
				build: {
					zig: { version: "0.16.0" },
					rust: { version: "1.88.0" },
					go: { version: "1.26.4" },
					odin: { version: "dev-2026-07a" },
				},
			}),
		).not.toThrow();
	});

	it("accepts an application config without product selection", () => {
		expect(() =>
			assertValidVersionPins({
				app: { name: "Example" },
				build: { mainProcess: "cottontail" },
			}),
		).not.toThrow();
	});

	it("rejects a non-object application configuration", () => {
		for (const config of [null, [], "config"]) {
			expect(() => assertValidVersionPins(config)).toThrow(
				"must export a configuration object",
			);
		}
	});

	it("rejects product selection in application configuration", () => {
		expect(() => assertValidVersionPins({ electrobun: {} })).toThrow(
			"Move electrobun.version to hutch.config.ts",
		);
		expect(() =>
			assertValidVersionPins({ electrobun: { version: "2.0.0" } }),
		).toThrow("Move electrobun.version to hutch.config.ts");
	});

	it.each([
		["zig", "master"],
		["zig", "0.16.0-dev.01"],
		["rust", "stable"],
		["rust", "1.88.0-01"],
		["go", ">=1.24"],
		["odin", "dev-latest"],
		["odin", "../dev-2026-07a"],
	] as const)("rejects a non-exact %s toolchain version", (language, version) => {
		expect(() =>
			assertValidVersionPins({
				build: { [language]: { version } },
			}),
		).toThrow(`build.${language}.version must be an exact version`);
	});
});
