// Per-mount text backend. The Zig UI core keeps layout, clipping, paint order
// and the render pass; this module is the FFI boundary for an application
// backend such as Glyph/Slug.
import { JSCallback, toArrayBuffer, type Pointer } from "bun:ffi";
import { GPUDevice, GPURenderPassEncoder } from "../webgpuAdapter";
import { uiLib } from "./ffi";

export interface UiTextRun {
	id: number;
	text: string;
	size: number;
	/** Packed 0xRRGGBBAA. */
	color: number;
	x: number;
	y: number;
}

export interface UiTextViewport {
	width: number;
	height: number;
	pixelWidth: number;
	pixelHeight: number;
}

/** Device and pass types come from Electrobun's partial native WebGPU adapter. */
export interface UiTextRenderer {
	measure(text: string, size: number): { w: number; h: number };
	/** Prepare uploads and retire resources for text absent from this frame. */
	prepare(runs: readonly UiTextRun[], viewport: UiTextViewport): void;
	/** Draw into the borrowed pass. Do not retain it, end it, or submit it.
	 * The engine sets the viewport and ancestor scissor before each draw. */
	draw(pass: GPURenderPassEncoder, run: UiTextRun): void;
	dispose(): void;
}

/** The device is borrowed; dispose only resources owned by this backend. */
export type UiTextRendererFactory = (context: {
	device: GPUDevice;
	format: string;
}) => UiTextRenderer | Promise<UiTextRenderer>;

const RUN_BYTES = 56;

const decode = new TextDecoder();

function readRun(base: number, index: number): UiTextRun {
	const view = new DataView(toArrayBuffer(base + index * RUN_BYTES, 0, RUN_BYTES));
	const textPtr = Number(view.getBigUint64(8, true));
	const textLen = Number(view.getBigUint64(16, true));
	const text = textPtr && textLen ? decode.decode(new Uint8Array(toArrayBuffer(textPtr, 0, textLen))) : "";
	return {
		id: view.getUint32(0, true),
		text,
		size: view.getFloat32(24, true),
		color: view.getUint32(28, true) >>> 0,
		x: view.getFloat32(32, true),
		y: view.getFloat32(36, true),
	};
}

function readViewport(ptr: number): UiTextViewport {
	const view = new DataView(toArrayBuffer(ptr, 0, 16));
	return {
		width: view.getFloat32(0, true),
		height: view.getFloat32(4, true),
		pixelWidth: view.getFloat32(8, true),
		pixelHeight: view.getFloat32(12, true),
	};
}

/** Keeps the native callbacks alive and installs them on one UI instance. */
export class TextRendererBinding {
	private renderer: UiTextRenderer;
	private readonly measureCb: JSCallback;
	private readonly prepareCb: JSCallback;
	private readonly drawCb: JSCallback;
	private readonly disposeCb: JSCallback;
	private disposed = false;

	constructor(uiId: number, renderer: UiTextRenderer) {
		this.renderer = renderer;
		const binding = this;
		this.measureCb = new JSCallback((textPtr: number, len: number | bigint, size: number, outW: number, outH: number) => {
			try {
				const n = Number(len);
				const text = n > 0 ? decode.decode(new Uint8Array(toArrayBuffer(textPtr, 0, n))) : "";
				const m = binding.renderer.measure(text, size);
				new DataView(toArrayBuffer(outW, 0, 4)).setFloat32(0, m.w, true);
				new DataView(toArrayBuffer(outH, 0, 4)).setFloat32(0, m.h, true);
				return 1;
			} catch {
				return 0;
			}
		}, { args: ["ptr", "u64", "f32", "ptr", "ptr"], returns: "u8", threadsafe: true });
		this.prepareCb = new JSCallback((runsPtr: number, count: number | bigint, viewportPtr: number) => {
			try {
				const n = Number(count);
				const runs: UiTextRun[] = [];
				for (let i = 0; i < n; i += 1) runs.push(readRun(runsPtr, i));
				binding.renderer.prepare(runs, readViewport(viewportPtr));
				return 0;
			} catch {
				return 1;
			}
		}, { args: ["ptr", "u64", "ptr"], returns: "u8", threadsafe: true });
		this.drawCb = new JSCallback((passPtr: number, runPtr: number) => {
			const pass = new GPURenderPassEncoder(passPtr);
			try {
				binding.renderer.draw(pass, readRun(runPtr, 0));
				return 0;
			} catch {
				return 1;
			} finally {
				// The engine ends and releases the pass. Drop our handle so a
				// later end() cannot release it a second time.
				pass.ptr = 0;
			}
		}, { args: ["ptr", "ptr"], returns: "u8", threadsafe: true });
		this.disposeCb = new JSCallback(() => {
			if (binding.disposed) return;
			binding.disposed = true;
			try {
				binding.renderer.dispose();
			} catch {
				// Native teardown must finish even if the backend throws.
			}
		}, { args: [], returns: "void", threadsafe: true });
		const ptrs = [this.measureCb.ptr, this.prepareCb.ptr, this.drawCb.ptr, this.disposeCb.ptr];
		if (ptrs.some((p) => p == null)) throw new Error("electrobun UI: failed to allocate text renderer callbacks");
		uiLib().ebui_set_text_renderer(uiId, null, ptrs[0] as Pointer, ptrs[1] as Pointer, ptrs[2] as Pointer, ptrs[3] as Pointer);
	}

	/** Drop the JS callbacks after the native UI has finished calling dispose. */
	close(): void {
		this.measureCb.close();
		this.prepareCb.close();
		this.drawCb.close();
		this.disposeCb.close();
	}
}
