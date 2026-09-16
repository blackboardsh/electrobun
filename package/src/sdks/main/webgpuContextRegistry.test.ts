import { describe, expect, test } from "bun:test";
import {
	WebgpuContextRegistry,
	createNativeWebgpuContext,
	registerWebgpuContextRelease,
	releaseNativeWebgpuContext,
	releaseWebgpuContext,
} from "./webgpuContextRegistry";

describe("WebGPU context lifecycle", () => {
	test("release evicts the entry, clears the latest fallback, and tears down once", () => {
		const registry = new WebgpuContextRegistry<object>();
		const context = {};
		let teardowns = 0;
		registry.set(2, {
			instance: 10,
			surface: 20,
			context,
			teardown: () => teardowns++,
		});

		expect(registry.lastCreatedContext).toBe(context);
		expect(registry.release(2)).toBe(true);
		expect(registry.get(2)).toBeUndefined();
		expect(registry.size).toBe(0);
		expect(registry.lastCreatedContext).toBeNull();
		expect(registry.release(2)).toBe(false);
		expect(teardowns).toBe(1);
	});

	test("releasing an older entry preserves the newer fallback", () => {
		const registry = new WebgpuContextRegistry<object>();
		const older = {};
		const newer = {};
		registry.set(1, {
			instance: 1,
			surface: 1,
			context: older,
			teardown: () => {},
		});
		registry.set(2, {
			instance: 2,
			surface: 2,
			context: newer,
			teardown: () => {},
		});

		registry.release(1);

		expect(registry.lastCreatedContext).toBe(newer);
	});

	test("releasing the newest entry falls back to the newest remaining context", () => {
		const registry = new WebgpuContextRegistry<object>();
		const oldest = {};
		const middle = {};
		const newest = {};
		for (const [key, context] of [oldest, middle, newest].entries()) {
			registry.set(key, {
				instance: key + 1,
				surface: key + 1,
				context,
				teardown: () => {},
			});
		}

		registry.release(2);

		expect(registry.lastCreatedContext).toBe(middle);
	});

	test("native release continues through individual teardown failures", () => {
		const calls: string[] = [];
		releaseNativeWebgpuContext(
			{ instance: 10, surface: 20 },
			{
				unconfigureSurface: () => {
					calls.push("unconfigure");
					throw new Error("already unconfigured");
				},
				releaseSurface: () => calls.push("surface"),
				releaseInstance: () => calls.push("instance"),
			},
		);

		expect(calls).toEqual(["unconfigure", "surface", "instance"]);
	});

	test("view removal dispatches a registered release only once", () => {
		let releases = 0;
		registerWebgpuContextRelease(987654, () => releases++);

		expect(releaseWebgpuContext(987654)).toBe(true);
		expect(releaseWebgpuContext(987654)).toBe(false);
		expect(releases).toBe(1);
	});

	test("surface creation failure rolls back the instance without touching a zero surface", () => {
		const calls: string[] = [];
		expect(() =>
			createNativeWebgpuContext(
				{
					createInstance: () => 10,
					createSurface: () => 0,
					unconfigureSurface: () => calls.push("unconfigure"),
					releaseSurface: () => calls.push("surface"),
					releaseInstance: () => calls.push("instance"),
				},
				() => ({}),
			),
		).toThrow("Failed to create WGPU surface");
		expect(calls).toEqual(["instance"]);
	});

	test("pre-registration failure rolls back surface and instance", () => {
		const calls: string[] = [];
		expect(() =>
			createNativeWebgpuContext(
				{
					createInstance: () => 10,
					createSurface: () => 20,
					unconfigureSurface: () => calls.push("unconfigure"),
					releaseSurface: () => calls.push("surface"),
					releaseInstance: () => calls.push("instance"),
				},
				() => {
					throw new Error("initialization failed");
				},
			),
		).toThrow("initialization failed");
		expect(calls).toEqual(["unconfigure", "surface", "instance"]);
	});
});
