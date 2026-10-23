// Keep native-module mocks inside a child process.
import { mock } from "bun:test";
import { strict as assert } from "node:assert";
import type { PaintBuffer } from "../paint";
import type { UiTextRenderer } from "../textRenderer";

const events: unknown[][] = [];
const resource = (kind: string) => ({
	release() { events.push(["release", kind]); },
	destroy() { events.push(["destroy", kind]); },
});
let encoderFailure = false, viewFailure = false, pendingFrame = false;
let pipeline: unknown;
let scissor: number[];
const pass = {
	setViewport(...values: number[]) { events.push(["viewport", ...values]); },
	setScissorRect(...values: number[]) { scissor = values; },
	setPipeline(value: unknown) { pipeline = value; },
	setBindGroup() {}, setVertexBuffer() {},
	draw(_vertices: number, count: number, _firstVertex: number, first: number) {
		assert.equal(pipeline, builtin);
		assert.deepEqual(scissor, [0, 0, 200, 100]);
		events.push(["quad", first, count]);
	},
	end() { events.push(["end"]); },
};
const builtin = { ...resource("pipeline"), getBindGroupLayout: () => resource("layout") };
const device = {
	createShaderModule: () => resource("shader"),
	createRenderPipeline: () => builtin,
	createBuffer: () => resource("buffer"),
	createTexture: () => ({ ...resource("texture"), createView: () => resource("atlas-view") }),
	createSampler: () => resource("sampler"),
	createBindGroup: () => resource("bind-group"),
	createCommandEncoder() {
		events.push(["encoder"]);
		if (encoderFailure) throw new Error("encoder failed");
		return {
			ptr: 1,
			beginRenderPass: () => pass,
			finish() {
				this.ptr = 0;
				events.push(["finish"]);
				return { _releaseReference() { events.push(["discard"]); } };
			},
		};
	},
	queue: { writeBuffer() {}, writeTexture() {}, submit() { events.push(["submit"]); } },
	destroy() { events.push(["destroy", "device"]); },
};
const context = {
	width: 200, height: 100, format: "bgra8unorm", _fallbackSize: { width: 200, height: 100 },
	configure() { events.push(["configure"]); },
	unconfigure() { pendingFrame = false; events.push(["unconfigure"]); },
	getCurrentTexture() {
		pendingFrame = true;
		events.push(["acquire"]);
		return { createView() {
			if (viewFailure) throw new Error("view failed");
			return resource("frame-view");
		} };
	},
};
mock.module("../../webgpuAdapter", () => ({ default: {
	createContext: () => ({ context }),
	navigator: { requestAdapter: async () => ({ requestDevice: async () => device }) },
} }));
const { createUiRenderer } = await import("../renderer");
const factoryCalls: unknown[] = [];
let drawFailure = false, prepareFailure = false;
const text: UiTextRenderer = {
	measure: () => ({ w: 30, h: 12 }),
	prepare(runs, viewport) {
		assert.deepEqual(viewport, { width: 100, height: 50, pixelWidth: 200, pixelHeight: 100 });
		events.push(["prepare", runs.length]);
		if (prepareFailure) throw new Error("prepare failed");
	},
	draw(_pass, run) {
		assert.deepEqual(scissor, [10, 12, 80, 40]);
		events.push(["text", run.id]);
		pass.setPipeline("custom");
		pass.setScissorRect(0, 0, 1, 1);
		if (drawFailure) throw new Error("draw failed");
	},
	dispose() { events.push(["dispose-text"]); },
};
const renderer = await createUiRenderer({ id: 1 } as never, "#000", { width: 100, height: 50 }, async (args) => {
	factoryCalls.push(args); return text;
});
assert.equal(factoryCalls.length, 1);
assert.equal(renderer.text, text);
renderer.resize(200, 100);
const buffer: PaintBuffer = {
	data: new Float32Array(60), count: 3,
	texts: [1, 2, 3].map((id) => ({
		id, text: "abc", size: 12, color: 0xffffffff, x: 5, y: 6,
		clip: { x: 5, y: 6, w: 40, h: 20 }, beforeInstance: id === 3 ? 2 : 1,
	})),
};
events.length = 0;
renderer.render(buffer, 100, 50);
assert.deepEqual(events.filter(([event]) => event === "quad" || event === "text"), [
	["quad", 0, 1], ["text", 1], ["text", 2], ["quad", 1, 1], ["text", 3], ["quad", 2, 1],
]);
assert.equal(events.filter(([event]) => event === "submit").length, 1);
assert.deepEqual(events.at(-1), ["release", "frame-view"]);
events.length = 0;
prepareFailure = true;
assert.throws(() => renderer.render(buffer, 100, 50), /prepare failed/);
assert.ok(!events.some(([event]) => event === "encoder"));
assert.ok(!events.some(([event]) => event === "acquire"));
prepareFailure = false;
events.length = 0;
encoderFailure = true;
assert.throws(() => renderer.render(buffer, 100, 50), /encoder failed/);
assert.ok(!events.some(([event]) => event === "acquire"));
encoderFailure = false;
events.length = 0;
viewFailure = true;
assert.throws(() => renderer.render(buffer, 100, 50), /view failed/);
assert.equal(pendingFrame, false);
assert.ok(events.some(([event]) => event === "discard"));
assert.ok(events.some(([event]) => event === "configure"));
viewFailure = false;
events.length = 0;
drawFailure = true;
assert.throws(() => renderer.render(buffer, 100, 50), /draw failed/);
assert.ok(events.some(([event]) => event === "end"));
assert.ok(events.some(([event]) => event === "discard"));
assert.ok(events.some(([event]) => event === "unconfigure"));
assert.ok(!events.some(([event]) => event === "submit"));
assert.equal(pendingFrame, false);
assert.deepEqual(events.at(-1), ["release", "frame-view"]);
drawFailure = false;
events.length = 0;
renderer.render(buffer, 100, 50);
assert.ok(events.some(([event]) => event === "submit"));
events.length = 0;
renderer.dispose(); renderer.dispose();
assert.equal(events.filter(([event]) => event === "dispose-text").length, 1);
assert.ok(events.findIndex(([event]) => event === "dispose-text") < events.findIndex(([event, kind]) => event === "destroy" && kind === "device"));
events.length = 0;
await assert.rejects(createUiRenderer({ id: 2 } as never, "#000", { width: 100, height: 50 }, async () => {
	throw new Error("factory failed");
}), /factory failed/);
assert.ok(events.some(([event, kind]) => event === "destroy" && kind === "device"));
console.log("Warren text renderer contract: PASS");
