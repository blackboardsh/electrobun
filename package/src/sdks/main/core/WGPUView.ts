import { ffi } from "../proc/native";
import electrobunEventEmitter from "../events/eventEmitter";
import { type Pointer } from "bun:ffi";

const WGPUViewMap: {
	[id: number]: WGPUView;
} = {};

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
	id: number = 0;
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
	isRemoved: boolean = false;

	get ptr(): Pointer | null {
		if (this.isRemoved) {
			return null;
		}
		return ffi.request.getWGPUViewPointer({ id: this.id }) as Pointer | null;
	}

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

		this.id = this.init() as number;
		WGPUViewMap[this.id] = this;
	}

	init() {
		return ffi.request.createWGPUView({
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
		if (this.isRemoved) {
			return;
		}

		this.isRemoved = true;
		delete WGPUViewMap[this.id];

		try {
			ffi.request.wgpuViewRemove({ id: this.id });
		} catch (e) {
			console.error(`Error removing WGPU view ${this.id}:`, e);
		}
	}

	getNativeHandle() {
		return ffi.request.wgpuViewGetNativeHandle({ id: this.id });
	}

	static getById(id: number) {
		return WGPUViewMap[id];
	}

	static adoptExisting(id: number, options: Partial<WGPUViewOptions> = {}) {
		const existing = WGPUViewMap[id];
		if (existing) {
			return existing;
		}

		const ptr = ffi.request.getWGPUViewPointer({ id }) as Pointer | null;
		if (!ptr) {
			return undefined;
		}

		const view = Object.create(WGPUView.prototype) as WGPUView;
		view.id = id;
		view.windowId = options.windowId ?? 0;
		view.autoResize = options.autoResize === false ? false : true;
		view.frame = {
			x: options.frame?.x ?? defaultOptions.frame!.x,
			y: options.frame?.y ?? defaultOptions.frame!.y,
			width: options.frame?.width ?? defaultOptions.frame!.width,
			height: options.frame?.height ?? defaultOptions.frame!.height,
		};
		view.startTransparent = options.startTransparent ?? false;
		view.startPassthrough = options.startPassthrough ?? false;
		view.isRemoved = false;
		WGPUViewMap[id] = view;
		return view;
	}

	static getAll() {
		return Object.values(WGPUViewMap);
	}
}
