import { ffi } from "../proc/native";
import electrobunEventEmitter from "../events/eventEmitter";
import { type Pointer } from "bun:ffi";

const WGPUViewMap: {
	[id: number]: WGPUView;
} = {};

let nextWGPUViewId = 1;

export type WGPUViewOptions = {
	frame: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
	autoResize: boolean;
	windowId: number;
	startTransparent: boolean;
	startPassthrough: boolean;
};

const defaultOptions: Partial<WGPUViewOptions> = {
	frame: {
		x: 0,
		y: 0,
		width: 800,
		height: 600,
	},
	autoResize: true,
	startTransparent: false,
	startPassthrough: false,
};

export class WGPUView {
	id: number = nextWGPUViewId++;
	ptr!: Pointer;
	windowId!: number;
	autoResize: boolean = true;
	frame: {
		x: number;
		y: number;
		width: number;
		height: number;
	} = {
		x: 0,
		y: 0,
		width: 800,
		height: 600,
	};
	startTransparent: boolean = false;
	startPassthrough: boolean = false;

	constructor(options: Partial<WGPUViewOptions> = defaultOptions) {
		this.frame = {
			x: options.frame?.x ?? defaultOptions.frame!.x,
			y: options.frame?.y ?? defaultOptions.frame!.y,
			width: options.frame?.width ?? defaultOptions.frame!.width,
			height: options.frame?.height ?? defaultOptions.frame!.height,
		};
		this.windowId = options.windowId ?? 0;
		this.autoResize = options.autoResize === false ? false : true;
		this.startTransparent = options.startTransparent ?? false;
		this.startPassthrough = options.startPassthrough ?? false;

		WGPUViewMap[this.id] = this;
		this.ptr = this.init() as Pointer;
	}

	init() {
		return ffi.request.createWGPUView({
			id: this.id,
			windowId: this.windowId,
			frame: {
				width: this.frame.width,
				height: this.frame.height,
				x: this.frame.x,
				y: this.frame.y,
			},
			autoResize: this.autoResize,
			startTransparent: this.startTransparent,
			startPassthrough: this.startPassthrough,
		});
	}

	setFrame(x: number, y: number, width: number, height: number) {
		this.frame = { x, y, width, height };
		ffi.request.wgpuViewSetFrame({ id: this.id, x, y, width, height });
	}

	setTransparent(transparent: boolean) {
		ffi.request.wgpuViewSetTransparent({ id: this.id, transparent });
	}

	setPassthrough(passthrough: boolean) {
		ffi.request.wgpuViewSetPassthrough({ id: this.id, passthrough });
	}

	setHidden(hidden: boolean) {
		ffi.request.wgpuViewSetHidden({ id: this.id, hidden });
	}

	on(name: "frame-updated", handler: (event: unknown) => void) {
		const specificName = `${name}-${this.id}`;
		electrobunEventEmitter.on(specificName, handler);
	}

	remove() {
		ffi.request.wgpuViewRemove({ id: this.id });
		delete WGPUViewMap[this.id];
	}

	getNativeHandle() {
		return ffi.request.wgpuViewGetNativeHandle({ id: this.id });
	}

	static getById(id: number) {
		return WGPUViewMap[id];
	}

	static getAll() {
		return Object.values(WGPUViewMap);
	}
}
