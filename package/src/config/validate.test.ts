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
	it("accepts exact product and native toolchain versions", () => {
		expect(() =>
			assertValidVersionPins({
				electrobun: { version: "2.1.0-beta.3+build.7" },
				build: {
					zig: { version: "0.16.0" },
					rust: { version: "1.88.0" },
					go: { version: "1.26.4" },
					odin: { version: "dev-2026-07a" },
				},
			}),
		).not.toThrow();
	});

	it("rejects a config without a v2 devkit pin", () => {
		expect(() =>
			assertValidVersionPins({
				build: { mainProcess: "cottontail" },
			}),
		).toThrow("electrobun.version must be an exact version");
	});

	it.each([
		"",
		"2",
		"02.0.0",
		"2.0.0-beta.01",
		"v2.0.0",
		"^2.0.0",
		"latest",
		"file:../core",
		".",
		"..",
	])(
		"rejects a non-exact Electrobun version: %s",
		(version) => {
			expect(() =>
				assertValidVersionPins({ electrobun: { version } }),
			).toThrow("electrobun.version must be an exact version");
		},
	);

	it("requires a version inside an explicit Electrobun selection", () => {
		expect(() => assertValidVersionPins({ electrobun: {} })).toThrow(
			"electrobun.version must be an exact version",
		);
		expect(() =>
			assertValidVersionPins({ electrobun: { version: 2 } }),
		).toThrow("electrobun.version must be an exact version");
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
				electrobun: { version: "2.0.0" },
				build: { [language]: { version } },
			}),
		).toThrow(`build.${language}.version must be an exact version`);
	});
});
