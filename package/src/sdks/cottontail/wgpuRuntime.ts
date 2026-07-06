// @ts-nocheck

type Rect = { x: number; y: number; width: number; height: number };
export type Pointer = number;

type ElectrobunRuntimeHost = {
	createWindow(options?: {
		title?: string;
		x?: number;
		y?: number;
		width?: number;
		height?: number;
		titleBarStyle?: string;
		transparent?: boolean;
		hidden?: boolean;
		activate?: boolean;
		quitOnClose?: boolean;
	}): number;
	closeWindow(windowId: number): void;
	setWindowAlwaysOnTop(windowId: number, flag: boolean): void;
	getWindowFrame(windowId: number): string | null;
	createWGPUView(options: {
		windowId: number;
		x?: number;
		y?: number;
		width?: number;
		height?: number;
		startTransparent?: boolean;
		startPassthrough?: boolean;
		hidden?: boolean;
	}): number;
	resizeView(symbol: string, viewId: number, x: number, y: number, width: number, height: number, masksJSON: string): void;
	coreCall(signature: string, symbol: string, ...args: any[]): any;
	nativeCall(library: "core" | "wgpu", symbol: string, returnType: "void" | "ptr" | "u32" | "u64" | "bool", ...args: any[]): any;
	memoryAddress(value: ArrayBuffer | ArrayBufferView | number | bigint): number;
	memoryView(ptr: number | bigint, offset: number | bigint, length: number | bigint): ArrayBuffer;
};

const runtimeNative = (globalThis as any).electrobun as ElectrobunRuntimeHost | undefined;
if (!runtimeNative) {
	throw new Error("electrobun/cottontail WGPU runtime requires `cottontail electrobun` mode");
}

function parseJSON<T>(value: unknown, fallback: T): T {
	if (!value) return fallback;
	if (typeof value !== "string") return value as T;
	return JSON.parse(value) as T;
}

function toNumber(value: unknown): number {
	if (typeof value === "bigint") return Number(value);
	return Number(value ?? 0);
}

export function ptr(value: ArrayBuffer | ArrayBufferView | number | bigint | null | undefined): number {
	if (value == null) return 0;
	return toNumber(runtimeNative.memoryAddress(value as any));
}

export function toArrayBuffer(pointer: number | bigint, offset = 0, length = 0): ArrayBuffer {
	return runtimeNative.memoryView(pointer, offset, length);
}

export class CString {
	buffer: Uint8Array;
	ptr: number;

	constructor(value: string) {
		this.buffer = new TextEncoder().encode(`${value}\0`);
		this.ptr = ptr(this.buffer);
	}
}

export class JSCallback {
	ptr = 0;
	constructor(_fn: Function, _options?: unknown) {}
}

export function inflateSync(_data: Uint8Array): Uint8Array {
	throw new Error("inflateSync is not available in the Cottontail WGPU adapter yet");
}

function coreCall(signature: string, symbol: string, ...args: any[]): any {
	return runtimeNative.coreCall(signature, symbol, ...args);
}

function nativeCall(library: "core" | "wgpu", symbol: string, returnType: "void" | "ptr" | "u32" | "u64" | "bool", ...args: any[]): any {
	return runtimeNative.nativeCall(library, symbol, returnType, ...args);
}

const voidWgpuSymbols = new Set([
	"wgpuBufferDestroy",
	"wgpuBufferUnmap",
	"wgpuCommandBufferRelease",
	"wgpuCommandEncoderCopyBufferToBuffer",
	"wgpuCommandEncoderCopyBufferToTexture",
	"wgpuCommandEncoderRelease",
	"wgpuComputePassEncoderDispatchWorkgroups",
	"wgpuComputePassEncoderEnd",
	"wgpuDeviceDestroy",
	"wgpuDeviceRelease",
	"wgpuDeviceTick",
	"wgpuInstanceProcessEvents",
	"wgpuQueueSubmit",
	"wgpuQueueWriteBuffer",
	"wgpuQueueWriteTexture",
	"wgpuRenderPassEncoderDraw",
	"wgpuRenderPassEncoderDrawIndexed",
	"wgpuRenderPassEncoderEnd",
	"wgpuRenderPassEncoderSetBindGroup",
	"wgpuRenderPassEncoderSetIndexBuffer",
	"wgpuRenderPassEncoderSetPipeline",
	"wgpuRenderPassEncoderSetScissorRect",
	"wgpuRenderPassEncoderSetVertexBuffer",
	"wgpuRenderPassEncoderSetViewport",
	"wgpuSurfaceGetCapabilities",
	"wgpuSurfaceUnconfigure",
	"wgpuTextureDestroy",
	"wgpuTextureRelease",
	"wgpuTextureViewRelease",
]);

const u32WgpuSymbols = new Set([
	"wgpuBufferGetMapState",
	"wgpuTextureGetFormat",
]);

const u64WgpuSymbols = new Set([
	"wgpuAdapterRequestDevice",
	"wgpuBufferMapAsync",
	"wgpuDeviceCreateComputePipelineAsync",
	"wgpuDeviceCreateRenderPipelineAsync",
	"wgpuInstanceRequestAdapter",
	"wgpuInstanceWaitAny",
	"wgpuQueueOnSubmittedWorkDone",
]);

function wgpuReturnType(symbol: string): "void" | "ptr" | "u32" | "u64" {
	if (voidWgpuSymbols.has(symbol) || symbol.endsWith("Release") || symbol.endsWith("AddRef") || symbol.endsWith("SetLabel")) return "void";
	if (u32WgpuSymbols.has(symbol) || symbol.startsWith("wgpuDeviceHas") || symbol.startsWith("wgpuAdapterHas")) return "u32";
	if (u64WgpuSymbols.has(symbol)) return "u64";
	return "ptr";
}

export const WGPU = {
	native: {
		available: true,
		symbols: new Proxy({}, {
			get(_target, property) {
				const symbol = String(property);
				return (...args: any[]) => nativeCall("wgpu", symbol, wgpuReturnType(symbol), ...args);
			},
		}),
	},
};

export class WGPUView {
	id: number;
	windowId: number;
	frame: Rect;
	isRemoved = false;

	constructor(options: Partial<{ frame: Rect; windowId: number; startTransparent: boolean; startPassthrough: boolean; hidden: boolean }> = {}) {
		this.windowId = options.windowId ?? 0;
		this.frame = {
			x: options.frame?.x ?? 0,
			y: options.frame?.y ?? 0,
			width: options.frame?.width ?? 800,
			height: options.frame?.height ?? 600,
		};
		this.id = runtimeNative.createWGPUView({
			windowId: this.windowId,
			...this.frame,
			startTransparent: options.startTransparent ?? false,
			startPassthrough: options.startPassthrough ?? false,
			hidden: options.hidden ?? false,
		});
		WGPUView.map.set(this.id, this);
	}

	get ptr(): number {
		if (this.isRemoved) return 0;
		return toNumber(nativeCall("core", "getWGPUViewPointer", "ptr", this.id));
	}

	getNativeHandle(): number {
		if (this.isRemoved) return 0;
		return toNumber(nativeCall("core", "getWGPUViewNativeHandle", "ptr", this.id));
	}

	setFrame(x: number, y: number, width: number, height: number): void {
		this.frame = { x, y, width, height };
		runtimeNative.resizeView("resizeWGPUView", this.id, x, y, width, height, "[]");
	}

	setTransparent(transparent: boolean): void {
		coreCall("u32_bool", "setWGPUViewTransparent", this.id, transparent);
	}

	setPassthrough(passthrough: boolean): void {
		coreCall("u32_bool", "setWGPUViewPassthrough", this.id, passthrough);
	}

	setHidden(hidden: boolean): void {
		coreCall("u32_bool", "setWGPUViewHidden", this.id, hidden);
	}

	remove(): void {
		if (this.isRemoved) return;
		this.isRemoved = true;
		WGPUView.map.delete(this.id);
		coreCall("u32", "removeWGPUView", this.id);
	}

	on(_name: string, _handler: Function): void {}

	static map = new Map<number, WGPUView>();
	static getById(id: number): WGPUView | undefined {
		return WGPUView.map.get(id);
	}
	static getAll(): WGPUView[] {
		return [...WGPUView.map.values()];
	}
}

export class GpuWindow {
	id: number;
	title: string;
	frame: Rect;
	transparent: boolean;
	wgpuView: WGPUView;
	wgpuViewId: number;

	constructor(options: Partial<{ title: string; frame: Partial<Rect>; titleBarStyle: string; transparent: boolean; activate: boolean }> = {}) {
		this.title = options.title ?? "Electrobun";
		this.frame = {
			x: options.frame?.x ?? 0,
			y: options.frame?.y ?? 0,
			width: options.frame?.width ?? 800,
			height: options.frame?.height ?? 600,
		};
		this.transparent = options.transparent ?? false;
		this.id = runtimeNative.createWindow({
			title: this.title,
			...this.frame,
			titleBarStyle: options.titleBarStyle ?? "default",
			transparent: this.transparent,
			activate: options.activate ?? true,
			quitOnClose: false,
		});
		this.wgpuView = new WGPUView({
			windowId: this.id,
			frame: { x: 0, y: 0, width: this.frame.width, height: this.frame.height },
			startTransparent: this.transparent,
		});
		this.wgpuViewId = this.wgpuView.id;
	}

	get ptr(): number {
		return toNumber(nativeCall("core", "getWindowPointer", "ptr", this.id));
	}

	getSize(): { width: number; height: number } {
		const frame = parseJSON<Rect>(runtimeNative.getWindowFrame(this.id), this.frame);
		return { width: frame.width, height: frame.height };
	}

	setAlwaysOnTop(flag: boolean): void {
		runtimeNative.setWindowAlwaysOnTop(this.id, flag);
	}

	close(): void {
		this.wgpuView.remove();
		runtimeNative.closeWindow(this.id);
	}

	on(_name: "close" | string, _handler: Function): void {}
}

export const WGPUBridge = {
	available: true,
	surfaceConfigure: (surfacePtr: Pointer, configPtr: Pointer) =>
		nativeCall("core", "wgpuSurfaceConfigureMainThread", "void", surfacePtr, configPtr),
	surfaceGetCurrentTexture: (surfacePtr: Pointer, surfaceTexturePtr: Pointer) =>
		nativeCall("core", "wgpuSurfaceGetCurrentTextureMainThread", "void", surfacePtr, surfaceTexturePtr),
	surfacePresent: (surfacePtr: Pointer): number =>
		toNumber(nativeCall("core", "wgpuSurfacePresentMainThread", "u32", surfacePtr)),
	queueOnSubmittedWorkDone: (queuePtr: Pointer, callbackInfoPtr: Pointer): bigint =>
		BigInt(nativeCall("core", "wgpuQueueOnSubmittedWorkDoneShim", "u64", queuePtr, callbackInfoPtr)),
	bufferMapAsync: (bufferPtr: Pointer, mode: bigint, offset: bigint, size: bigint, callbackInfoPtr: Pointer): bigint =>
		BigInt(nativeCall("core", "wgpuBufferMapAsyncShim", "u64", bufferPtr, mode, offset, size, callbackInfoPtr)),
	instanceWaitAny: (instancePtr: Pointer, futureId: bigint, timeoutNs: bigint): number =>
		toNumber(nativeCall("core", "wgpuInstanceWaitAnyShim", "u32", instancePtr, futureId, timeoutNs)),
	bufferReadSyncInto: (instancePtr: Pointer, bufferPtr: Pointer, offset: bigint, size: bigint, timeoutNs: bigint, dstPtr: Pointer): number =>
		toNumber(nativeCall("core", "wgpuBufferReadSyncIntoShim", "u32", instancePtr, bufferPtr, offset, size, timeoutNs, dstPtr)),
	bufferReadbackBegin: (bufferPtr: Pointer, offset: bigint, size: bigint, dstPtr: Pointer): Pointer =>
		toNumber(nativeCall("core", "wgpuBufferReadbackBeginShim", "ptr", bufferPtr, offset, size, dstPtr)),
	bufferReadbackStatus: (jobPtr: Pointer): number =>
		toNumber(nativeCall("core", "wgpuBufferReadbackStatusShim", "u32", jobPtr)),
	bufferReadbackFree: (jobPtr: Pointer) =>
		nativeCall("core", "wgpuBufferReadbackFreeShim", "void", jobPtr),
	runTest: (viewId: number) => coreCall("u32", "runWGPUViewTest", viewId),
	createAdapterDeviceMainThread: (instancePtr: Pointer, surfacePtr: Pointer, outAdapterDevicePtr: Pointer) =>
		nativeCall("core", "wgpuCreateAdapterDeviceMainThread", "void", instancePtr, surfacePtr, outAdapterDevicePtr),
	createSurfaceForView: (instancePtr: Pointer, viewPtr: Pointer): Pointer | null => {
		const surface = toNumber(nativeCall("core", "wgpuCreateSurfaceForView", "ptr", instancePtr, viewPtr));
		return surface || null;
	},
};

function encodeUtf8(input: string): Uint8Array {
	const bytes: number[] = [];
	for (let index = 0; index < input.length; index += 1) {
		let codePoint = input.charCodeAt(index);
		if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < input.length) {
			const next = input.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
				index += 1;
			}
		}
		if (codePoint <= 0x7f) {
			bytes.push(codePoint);
		} else if (codePoint <= 0x7ff) {
			bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
		} else if (codePoint <= 0xffff) {
			bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
		} else {
			bytes.push(0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
		}
	}
	return new Uint8Array(bytes);
}

function decodeUtf8(input: ArrayBuffer | ArrayBufferView): string {
	const bytes = input instanceof ArrayBuffer
		? new Uint8Array(input)
		: new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
	let output = "";
	for (let index = 0; index < bytes.length;) {
		const first = bytes[index++] ?? 0;
		let codePoint = first;
		if ((first & 0xe0) === 0xc0) {
			codePoint = ((first & 0x1f) << 6) | ((bytes[index++] ?? 0) & 0x3f);
		} else if ((first & 0xf0) === 0xe0) {
			codePoint = ((first & 0x0f) << 12) | (((bytes[index++] ?? 0) & 0x3f) << 6) | ((bytes[index++] ?? 0) & 0x3f);
		} else if ((first & 0xf8) === 0xf0) {
			codePoint = ((first & 0x07) << 18) | (((bytes[index++] ?? 0) & 0x3f) << 12) | (((bytes[index++] ?? 0) & 0x3f) << 6) | ((bytes[index++] ?? 0) & 0x3f);
		}
		if (codePoint <= 0xffff) {
			output += String.fromCharCode(codePoint);
		} else {
			codePoint -= 0x10000;
			output += String.fromCharCode(0xd800 + (codePoint >> 10), 0xdc00 + (codePoint & 0x3ff));
		}
	}
	return output;
}

type TimerRecord = {
	id: number;
	deadline: number;
	callback: Function;
	args: any[];
	intervalMs: number | null;
};

let nextTimerId = 1;
const timerRecords = new Map<number, TimerRecord>();
let drainingTimers = false;

function timerNow(): number {
	const perfNow = (globalThis as any).performance?.now;
	if (typeof perfNow === "function") return Number(perfNow.call((globalThis as any).performance));
	return Date.now();
}

export function drainTimerShim(): boolean {
	if (drainingTimers) return false;
	drainingTimers = true;
	let fired = false;
	try {
		const now = timerNow();
		const due = Array.from(timerRecords.values())
			.filter((record) => record.deadline <= now)
			.sort((a, b) => a.deadline - b.deadline || a.id - b.id);

		for (const record of due) {
			if (!timerRecords.has(record.id)) continue;
			timerRecords.delete(record.id);
			fired = true;
			record.callback(...record.args);
			if (record.intervalMs != null) {
				record.deadline = timerNow() + record.intervalMs;
				timerRecords.set(record.id, record);
			}
		}
	} finally {
		drainingTimers = false;
	}
	return fired;
}

export function installTimerShim(): void {
	const g = globalThis as any;
	g.self ??= g;
	g.performance ??= { now: () => Date.now() };
	g.performance.now ??= () => Date.now();
	g.TextEncoder ??= class TextEncoder {
		readonly encoding = "utf-8";
		encode(input = ""): Uint8Array {
			return encodeUtf8(String(input));
		}
	};
	g.TextDecoder ??= class TextDecoder {
		readonly encoding = "utf-8";
		decode(input: ArrayBuffer | ArrayBufferView = new ArrayBuffer(0)): string {
			return decodeUtf8(input);
		}
	};
	g.setTimeout = (fn: Function, ms = 0, ...args: any[]) => {
		const id = nextTimerId++;
		timerRecords.set(id, {
			id,
			deadline: timerNow() + Math.max(0, Number(ms) || 0),
			callback: fn,
			args,
			intervalMs: null,
		});
		return id;
	};
	g.clearTimeout = (id: any) => {
		timerRecords.delete(Number(id));
	};
	g.setInterval = (fn: Function, ms = 0, ...args: any[]) => {
		const id = nextTimerId++;
		const intervalMs = Math.max(0, Number(ms) || 0);
		timerRecords.set(id, {
			id,
			deadline: timerNow() + intervalMs,
			callback: fn,
			args,
			intervalMs,
		});
		return id;
	};
	g.clearInterval = (id: any) => g.clearTimeout(id);
	if (!g.requestAnimationFrame) {
		g.requestAnimationFrame = (fn: Function) => g.setTimeout(() => fn(g.performance.now()), 16);
	}
	if (!g.cancelAnimationFrame) {
		g.cancelAnimationFrame = (id: any) => g.clearTimeout(id);
	}
}
