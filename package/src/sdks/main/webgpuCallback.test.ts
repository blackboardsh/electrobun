import { describe, expect, test } from "bun:test";
import { stringViewCallbackAbi } from "./webgpuCallback";

describe("WGPUStringView callback ABI", () => {
	test("Windows x64 receives a pointer to the aggregate", () => {
		expect(stringViewCallbackAbi("win32", "x64")).toEqual({
			indirect: true,
			args: ["u32", "ptr", "ptr", "ptr"],
		});
	});

	test("ARM64 and SysV receive data and length before userdata", () => {
		for (const [platform, architecture] of [
			["win32", "arm64"],
			["darwin", "arm64"],
			["darwin", "x64"],
			["linux", "arm64"],
			["linux", "x64"],
		] as const) {
			expect(stringViewCallbackAbi(platform, architecture)).toEqual({
				indirect: false,
				args: ["u32", "ptr", "u64", "ptr", "ptr"],
			});
		}
	});
});
