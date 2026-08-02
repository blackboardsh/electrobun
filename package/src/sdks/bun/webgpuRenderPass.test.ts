import { describe, expect, it } from "bun:test";
import {
	mapLoadOp,
	mapStoreOp,
	normalizeRenderPassDepthStencilFields,
	WGPULoadOp,
	WGPUStoreOp,
} from "./webgpuRenderPass";

describe("WebGPU render-pass depth/stencil conversion", () => {
	it("leaves omitted stencil operations undefined for depth-only formats", () => {
		const fields = normalizeRenderPassDepthStencilFields({
			depthLoadOp: "clear",
			depthStoreOp: "store",
			depthClearValue: 0.5,
		});

		expect(fields).toEqual({
			depthLoadOp: WGPULoadOp.Clear,
			depthStoreOp: WGPUStoreOp.Store,
			depthClearValue: 0.5,
			depthReadOnly: false,
			stencilLoadOp: WGPULoadOp.Undefined,
			stencilStoreOp: WGPUStoreOp.Undefined,
			stencilClearValue: 0,
			stencilReadOnly: false,
		});
	});

	it("leaves omitted depth and stencil operations undefined for read-only attachments", () => {
		const fields = normalizeRenderPassDepthStencilFields({
			depthReadOnly: true,
			stencilReadOnly: true,
		});

		expect(fields.depthLoadOp).toBe(WGPULoadOp.Undefined);
		expect(fields.depthStoreOp).toBe(WGPUStoreOp.Undefined);
		expect(fields.depthClearValue).toBe(0);
		expect(fields.stencilLoadOp).toBe(WGPULoadOp.Undefined);
		expect(fields.stencilStoreOp).toBe(WGPUStoreOp.Undefined);
		expect(fields.stencilClearValue).toBe(0);
		expect(fields.depthReadOnly).toBe(true);
		expect(fields.stencilReadOnly).toBe(true);
	});

	it("maps explicit stencil operations for depth-stencil formats", () => {
		const fields = normalizeRenderPassDepthStencilFields({
			depthLoadOp: "load",
			depthStoreOp: "discard",
			stencilLoadOp: "clear",
			stencilStoreOp: "store",
			stencilClearValue: 7,
		});

		expect(fields.depthLoadOp).toBe(WGPULoadOp.Load);
		expect(fields.depthStoreOp).toBe(WGPUStoreOp.Discard);
		expect(fields.stencilLoadOp).toBe(WGPULoadOp.Clear);
		expect(fields.stencilStoreOp).toBe(WGPUStoreOp.Store);
		expect(fields.stencilClearValue).toBe(7);
	});

	it("preserves numeric enum values and existing color-operation defaults", () => {
		const fields = normalizeRenderPassDepthStencilFields({
			depthLoadOp: WGPULoadOp.Load,
			depthStoreOp: WGPUStoreOp.Discard,
			stencilLoadOp: WGPULoadOp.Clear,
			stencilStoreOp: WGPUStoreOp.Store,
		});

		expect(fields.depthLoadOp).toBe(WGPULoadOp.Load);
		expect(fields.depthStoreOp).toBe(WGPUStoreOp.Discard);
		expect(fields.stencilLoadOp).toBe(WGPULoadOp.Clear);
		expect(fields.stencilStoreOp).toBe(WGPUStoreOp.Store);
		expect(mapLoadOp(undefined)).toBe(WGPULoadOp.Clear);
		expect(mapStoreOp(undefined)).toBe(WGPUStoreOp.Store);
	});
});
