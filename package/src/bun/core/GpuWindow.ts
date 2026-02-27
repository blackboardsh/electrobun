import { ffi } from "../proc/native";
import electrobunEventEmitter from "../events/eventEmitter";
import { type Pointer } from "bun:ffi";
import { WGPUView } from "./WGPUView";
import { getNextWindowId } from "./windowIds";


export type GpuWindowOptionsType = {
	title: string;
	frame: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
	styleMask?: {};
	titleBarStyle: "hidden" | "hiddenInset" | "default";
	transparent: boolean;
};

const defaultOptions: GpuWindowOptionsType = {
	title: "Electrobun",
	frame: {
		x: 0,
		y: 0,
		width: 800,
		height: 600,
	},
	titleBarStyle: "default",
	transparent: false,
};

export const GpuWindowMap: {
	[id: number]: GpuWindow;
} = {};

// Clean up the window map when a window closes and optionally quit the app
electrobunEventEmitter.on("close", (event: { data: { id: number } }) => {
	const windowId = event.data.id;
	delete GpuWindowMap[windowId];

	// Clean up all WGPU views associated with this window
	for (const view of WGPUView.getAll()) {
		if (view.windowId === windowId) {
			view.remove();
		}
	}

});

export class GpuWindow {
	id: number = getNextWindowId();
	ptr!: Pointer;
	title: string = "Electrobun";
	state: "creating" | "created" = "creating";
	transparent: boolean = false;
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
	wgpuViewId!: number;

	constructor(options: Partial<GpuWindowOptionsType> = defaultOptions) {
		this.title = options.title || "New Window";
		this.frame = options.frame
			? { ...defaultOptions.frame, ...options.frame }
			: { ...defaultOptions.frame };
		this.transparent = options.transparent ?? false;

		this.init(options);
	}

	init({
		styleMask,
		titleBarStyle,
		transparent,
	}: Partial<GpuWindowOptionsType>) {
		this.ptr = ffi.request.createWindow({
			id: this.id,
			title: this.title,
			url: "",
			frame: {
				width: this.frame.width,
				height: this.frame.height,
				x: this.frame.x,
				y: this.frame.y,
			},
			styleMask: {
				Borderless: false,
				Titled: true,
				Closable: true,
				Miniaturizable: true,
				Resizable: true,
				UnifiedTitleAndToolbar: false,
				FullScreen: false,
				FullSizeContentView: false,
				UtilityWindow: false,
				DocModalWindow: false,
				NonactivatingPanel: false,
				HUDWindow: false,
				...(styleMask || {}),
				// hiddenInset: transparent titlebar with inset native controls
				...(titleBarStyle === "hiddenInset"
					? {
							Titled: true,
							FullSizeContentView: true,
						}
					: {}),
				// hidden: no titlebar, no native controls (for fully custom chrome)
				...(titleBarStyle === "hidden"
					? {
							Titled: false,
							FullSizeContentView: true,
						}
					: {}),
			},
			titleBarStyle: titleBarStyle || "default",
			transparent: transparent ?? false,
		}) as Pointer;

		GpuWindowMap[this.id] = this;

		const wgpuView = new WGPUView({
			frame: {
				x: 0,
				y: 0,
				width: this.frame.width,
				height: this.frame.height,
			},
			windowId: this.id,
			autoResize: true,
			startTransparent: false,
			startPassthrough: false,
		});

		this.wgpuViewId = wgpuView.id;
	}

	get wgpuView() {
		return WGPUView.getById(this.wgpuViewId) as WGPUView;
	}

	static getById(id: number) {
		return GpuWindowMap[id];
	}

	setTitle(title: string) {
		this.title = title;
		return ffi.request.setTitle({ winId: this.id, title });
	}

	close() {
		return ffi.request.closeWindow({ winId: this.id });
	}

	focus() {
		return ffi.request.focusWindow({ winId: this.id });
	}

	show() {
		return ffi.request.focusWindow({ winId: this.id });
	}

	minimize() {
		return ffi.request.minimizeWindow({ winId: this.id });
	}

	unminimize() {
		return ffi.request.restoreWindow({ winId: this.id });
	}

	isMinimized(): boolean {
		return ffi.request.isWindowMinimized({ winId: this.id });
	}

	maximize() {
		return ffi.request.maximizeWindow({ winId: this.id });
	}

	unmaximize() {
		return ffi.request.unmaximizeWindow({ winId: this.id });
	}

	isMaximized(): boolean {
		return ffi.request.isWindowMaximized({ winId: this.id });
	}

	setFullScreen(fullScreen: boolean) {
		return ffi.request.setWindowFullScreen({ winId: this.id, fullScreen });
	}

	isFullScreen(): boolean {
		return ffi.request.isWindowFullScreen({ winId: this.id });
	}

	setAlwaysOnTop(alwaysOnTop: boolean) {
		return ffi.request.setWindowAlwaysOnTop({ winId: this.id, alwaysOnTop });
	}

	isAlwaysOnTop(): boolean {
		return ffi.request.isWindowAlwaysOnTop({ winId: this.id });
	}

	setPosition(x: number, y: number) {
		this.frame.x = x;
		this.frame.y = y;
		return ffi.request.setWindowPosition({ winId: this.id, x, y });
	}

	setSize(width: number, height: number) {
		this.frame.width = width;
		this.frame.height = height;
		return ffi.request.setWindowSize({ winId: this.id, width, height });
	}

	setFrame(x: number, y: number, width: number, height: number) {
		this.frame = { x, y, width, height };
		return ffi.request.setWindowFrame({ winId: this.id, x, y, width, height });
	}

	getFrame(): { x: number; y: number; width: number; height: number } {
		const frame = ffi.request.getWindowFrame({ winId: this.id });
		this.frame = frame;
		return frame;
	}

	getPosition(): { x: number; y: number } {
		const frame = this.getFrame();
		return { x: frame.x, y: frame.y };
	}

	getSize(): { width: number; height: number } {
		const frame = this.getFrame();
		return { width: frame.width, height: frame.height };
	}

	on(name: string, handler: (event: unknown) => void) {
		const specificName = `${name}-${this.id}`;
		electrobunEventEmitter.on(specificName, handler);
	}
}
