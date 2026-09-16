import { describe, expect, test } from "bun:test";
import { getWebgpuContextKey } from "./webgpuContextKey";

describe("WebGPU context registry keys", () => {
	test("a GpuWindow and its backing WGPUView share one key", () => {
		const window = { id: 41, wgpuViewId: 7 };
		const backingView = { id: 7 };

		expect(getWebgpuContextKey(window)).toBe(7);
		expect(getWebgpuContextKey(backingView)).toBe(7);
	});

	test("a window ID cannot collide with an unrelated child WGPUView ID", () => {
		const window = { id: 2, wgpuViewId: 1 };
		const childView = { id: 2 };

		expect(getWebgpuContextKey(window)).toBe(1);
		expect(getWebgpuContextKey(childView)).toBe(2);
	});
});
