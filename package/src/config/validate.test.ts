import { describe, expect, it } from "bun:test";
import { assertNoLegacyBunVersionConfig } from "./validate";

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
