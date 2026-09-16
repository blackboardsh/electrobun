import { describe, expect, test } from "bun:test";
import { WebgpuPresentationState } from "./webgpuPresentationState";

describe("WebGPU presentation state", () => {
	test("a queue submit presents only that queue's pending surfaces", () => {
		const state = new WebgpuPresentationState<object, object>();
		const queueA = {};
		const queueB = {};
		const surfaceA = {};
		const surfaceB = {};
		const presented: object[] = [];

		state.attach(queueA, surfaceA);
		state.attach(queueB, surfaceB);
		state.markPending(surfaceA);
		state.markPending(surfaceB);

		expect(state.presentPending(queueA, (surface) => presented.push(surface))).toBe(1);
		expect(presented).toEqual([surfaceA]);
		expect(state.isPending(surfaceA)).toBe(false);
		expect(state.isPending(surfaceB)).toBe(true);
	});

	test("detaching one surface leaves other queues and pending frames intact", () => {
		const state = new WebgpuPresentationState<object, object>();
		const queueA = {};
		const queueB = {};
		const surfaceA = {};
		const surfaceB = {};

		state.attach(queueA, surfaceA);
		state.attach(queueB, surfaceB);
		state.markPending(surfaceA);
		state.markPending(surfaceB);
		state.detachSurface(surfaceA);

		expect(state.isPending(surfaceA)).toBe(false);
		expect(state.isPending(surfaceB)).toBe(true);
		expect(state.presentPending(queueA, () => {})).toBe(0);
		expect(state.presentPending(queueB, () => {})).toBe(1);
	});

	test("reconfiguring a surface moves it to the new queue", () => {
		const state = new WebgpuPresentationState<object, object>();
		const queueA = {};
		const queueB = {};
		const surface = {};

		state.attach(queueA, surface);
		state.attach(queueB, surface);
		state.markPending(surface);

		expect(state.presentPending(queueA, () => {})).toBe(0);
		expect(state.presentPending(queueB, () => {})).toBe(1);
	});

	test("one queue presents only the surface referenced by submitted work", () => {
		const state = new WebgpuPresentationState<object, object>();
		const queue = {};
		const surfaceA = {};
		const surfaceB = {};
		const presented: object[] = [];
		state.attach(queue, surfaceA);
		state.attach(queue, surfaceB);
		state.markPending(surfaceA);
		state.markPending(surfaceB);

		expect(
			state.presentPendingSurface(queue, surfaceA, (surface) =>
				presented.push(surface),
			),
		).toBe(true);
		expect(presented).toEqual([surfaceA]);
		expect(state.isPending(surfaceB)).toBe(true);
	});
});
