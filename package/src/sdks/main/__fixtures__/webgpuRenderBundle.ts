// Run in its own Bun process so native-module mocks never affect other tests.
import { mock } from "bun:test";
import { strict as assert } from "node:assert";
import { toArrayBuffer } from "bun:ffi";

const finalizers: { pending: Map<object, number>; finalize(): void }[] = [];
Object.defineProperty(globalThis, "FinalizationRegistry", {
	value: class {
		pending = new Map<object, number>();
		constructor(private cleanup: (held: number) => void) { finalizers.push(this); }
		register(_target: object, held: number, token: object) { this.pending.set(token, held); }
		unregister(token: object) { return this.pending.delete(token); }
		finalize() {
			for (const held of this.pending.values()) this.cleanup(held);
			this.pending.clear();
		}
	},
});

const calls: { name: string; args: unknown[] }[] = [];
let finishResult = 301;
const bytes = (address: number, size: number) => new DataView(toArrayBuffer(address, 0, size));
const native = new Proxy<Record<string, (...args: any[]) => any>>({}, {
	get(_target, name: string) {
		return (...args: any[]) => {
			if (name === "wgpuDeviceCreateRenderBundleEncoder") {
				const descriptor = bytes(args[1], 56);
				const count = Number(descriptor.getBigUint64(24, true));
				const formats = count ? Array.from(new Uint32Array(toArrayBuffer(Number(descriptor.getBigUint64(32, true)), 0, count * 4))) : [];
				calls.push({ name, args: [
					descriptor.getBigUint64(0, true), formats,
					descriptor.getUint32(40, true), descriptor.getUint32(44, true),
					descriptor.getUint32(48, true), descriptor.getUint32(52, true),
				] });
				return 201;
			}
			if (name === "wgpuRenderBundleEncoderSetBindGroup") {
				const count = Number(args[3]);
				args[4] = count ? Array.from(new Uint32Array(toArrayBuffer(args[4], 0, count * 4))) : [];
			}
			if (name === "wgpuRenderPassEncoderExecuteBundles") {
				const count = Number(args[1]);
				args[2] = count ? Array.from(new BigUint64Array(toArrayBuffer(args[2], 0, count * 8))) : [];
			}
			calls.push({ name, args });
			if (name === "wgpuDeviceGetQueue") return 101;
			if (name === "wgpuRenderBundleEncoderFinish") return finishResult;
		};
	},
});
mock.module("../core/GpuWindow", () => ({ GpuWindow: class {} }));
mock.module("../core/WGPUView", () => ({ WGPUView: class {} }));
mock.module("../proc/native", () => ({ WGPUBridge: {} }));
mock.module("../webGPU", () => ({ default: { native: { symbols: native } } }));
const { GPUDevice, GPURenderPassEncoder, GPURenderBundle, GPUBindGroup, GPUBuffer, GPURenderPipeline } = await import("../webgpuAdapter");
const device = new GPUDevice(100);
const group = new GPUBindGroup(400);
const vertexBuffer = new GPUBuffer(500, 80, 0n, device);
const last = (name: string) => calls.findLast((call) => call.name === name)!.args;
const count = (name: string) => calls.filter((call) => call.name === name).length;

const encoder = device.createRenderBundleEncoder({
	colorFormats: ["bgra8unorm", null, "rgba8unorm"], depthStencilFormat: "depth24plus",
	sampleCount: 4, depthReadOnly: true, stencilReadOnly: false,
});
assert.deepEqual(last("wgpuDeviceCreateRenderBundleEncoder"), [0n, [27, 0, 22], 46, 4, 1, 0]);
device.createRenderBundleEncoder({ colorFormats: [] }).release();
assert.deepEqual(last("wgpuDeviceCreateRenderBundleEncoder"), [0n, [], 0, 1, 0, 0]);
assert.throws(() => device.createRenderBundleEncoder({ colorFormats: ["not-a-format"] }), TypeError);

encoder.setPipeline(new GPURenderPipeline(700));
assert.deepEqual(last("wgpuRenderBundleEncoderSetPipeline"), [201, 700]);
encoder.setBindGroup(2, group, [256, 512]);
assert.deepEqual(last("wgpuRenderBundleEncoderSetBindGroup"), [201, 2, 400, 2n, [256, 512]]);
encoder.setBindGroup(1, null);
assert.deepEqual(last("wgpuRenderBundleEncoderSetBindGroup"), [201, 1, 0, 0n, []]);
encoder.setBindGroup(0, group, new Uint32Array([10, 256, 512, 20]), 1, 2);
assert.deepEqual(last("wgpuRenderBundleEncoderSetBindGroup"), [201, 0, 400, 2n, [256, 512]]);
assert.throws(() => encoder.setBindGroup(0, null, new Uint32Array(2), 1, 2), RangeError);
encoder.setVertexBuffer(0, vertexBuffer, 16);
assert.deepEqual(last("wgpuRenderBundleEncoderSetVertexBuffer"), [201, 0, 500, 16n, 64n]);
encoder.setVertexBuffer(0, null);
assert.deepEqual(last("wgpuRenderBundleEncoderSetVertexBuffer"), [201, 0, 0, 0n, 0n]);
encoder.setIndexBuffer(vertexBuffer, "uint16", 12);
assert.deepEqual(last("wgpuRenderBundleEncoderSetIndexBuffer"), [201, 500, 1, 12n, 68n]);
encoder.draw(3);
assert.deepEqual(last("wgpuRenderBundleEncoderDraw"), [201, 3, 1, 0, 0]);
encoder.drawIndexed(6, 2, 3, -4, 5);
assert.deepEqual(last("wgpuRenderBundleEncoderDrawIndexed"), [201, 6, 2, 3, -4, 5]);
encoder.drawIndirect(vertexBuffer, 16);
assert.deepEqual(last("wgpuRenderBundleEncoderDrawIndirect"), [201, 500, 16n]);
encoder.drawIndexedIndirect(vertexBuffer, 32);
assert.deepEqual(last("wgpuRenderBundleEncoderDrawIndexedIndirect"), [201, 500, 32n]);
encoder.pushDebugGroup("group");
encoder.insertDebugMarker("marker");
encoder.popDebugGroup();
const bundle = encoder.finish({ label: "reusable" });
assert.ok(bundle instanceof GPURenderBundle);
assert.equal(bundle.label, "reusable");
assert.equal(encoder.ptr, 0);
const releases = count("wgpuRenderBundleEncoderRelease");
encoder.release();
assert.equal(count("wgpuRenderBundleEncoderRelease"), releases);
assert.throws(() => encoder.draw(3));
assert.throws(() => encoder.finish());
const pass = new GPURenderPassEncoder(600);
pass.executeBundles(new Set([bundle]));
assert.deepEqual(last("wgpuRenderPassEncoderExecuteBundles"), [600, 1n, [301n]]);
pass.executeBundles([bundle, bundle]);
assert.deepEqual(last("wgpuRenderPassEncoderExecuteBundles"), [600, 2n, [301n, 301n]]);
pass.executeBundles([]);
assert.deepEqual(last("wgpuRenderPassEncoderExecuteBundles"), [600, 0n, []]);
// @ts-expect-error Deliberately reject a forged native handle.
assert.throws(() => pass.executeBundles([{ ptr: 301 }]), TypeError);
bundle.release();
bundle.release();
assert.equal(count("wgpuRenderBundleRelease"), 1);
assert.throws(() => pass.executeBundles([bundle]));
finishResult = 0;
const failed = device.createRenderBundleEncoder({ colorFormats: [] });
assert.throws(() => failed.finish());
assert.equal(failed.ptr, 0);
assert.equal(count("wgpuRenderBundleEncoderRelease"), releases + 1);
assert.equal(finalizers[0]!.pending.size, 0);
assert.equal(finalizers[1]!.pending.size, 0);
const abandoned = device.createRenderBundleEncoder({ colorFormats: [] });
assert.ok(finalizers[1]!.pending.has(abandoned));
const unreleased = new GPURenderBundle(302);
assert.ok(finalizers[0]!.pending.has(unreleased));
const bundleReleases = count("wgpuRenderBundleRelease");
const encoderReleases = count("wgpuRenderBundleEncoderRelease");
finalizers[0]!.finalize();
finalizers[1]!.finalize();
assert.equal(count("wgpuRenderBundleRelease"), bundleReleases + 1);
assert.equal(count("wgpuRenderBundleEncoderRelease"), encoderReleases + 1);
console.log("native render-bundle adapter contract: PASS");
