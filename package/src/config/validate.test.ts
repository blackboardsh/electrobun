import { describe, expect, it } from "bun:test";
import { assertNoLegacyBunMainProcessConfig } from "./validate";

describe("assertNoLegacyBunMainProcessConfig", () => {
	it("accepts Cottontail and native main-process configurations", () => {
		expect(() =>
			assertNoLegacyBunMainProcessConfig({
				build: {
					mainProcess: "cottontail",
					cottontail: { entrypoint: "src/bun/index.ts" },
				},
			}),
		).not.toThrow();
		expect(() =>
			assertNoLegacyBunMainProcessConfig({
				build: { mainProcess: "zig" },
			}),
		).not.toThrow();
	});

	it.each([
		{ mainProcess: "bun" },
		{ bun: { entrypoint: "src/bun/index.ts" } },
		{ bunVersion: "1.3.8" },
		{ bunnyBun: "bunny-bun-test" },
	])("rejects removed Bun configuration: %p", (build) => {
		expect(() => assertNoLegacyBunMainProcessConfig({ build })).toThrow(
			'Use build.mainProcess = "cottontail"',
		);
	});
});
