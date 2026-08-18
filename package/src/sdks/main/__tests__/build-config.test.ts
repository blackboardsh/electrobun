import { describe, expect, it } from "bun:test";
import { isPackagedBuildChannel } from "../core/BuildConfig";

describe("BuildConfig runtime mode", () => {
	it("distinguishes development and packaged channels", () => {
		expect(isPackagedBuildChannel(undefined)).toBe(false);
		expect(isPackagedBuildChannel("")).toBe(false);
		expect(isPackagedBuildChannel("dev")).toBe(false);
		expect(isPackagedBuildChannel("canary")).toBe(true);
		expect(isPackagedBuildChannel("stable")).toBe(true);
		expect(isPackagedBuildChannel("production")).toBe(false);
		expect(isPackagedBuildChannel("nightly")).toBe(false);
	});
});
