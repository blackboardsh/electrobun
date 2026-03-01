import { ffi } from "../proc/native";
import electrobunEventEmitter from "../events/eventEmitter";
import { BrowserView } from "./BrowserView";
import { type Pointer } from "bun:ffi";
import { BuildConfig } from "./BuildConfig";
import { quit } from "./Utils";
import { type RPCWithTransport } from "../../shared/rpc.js";
import { getNextWindowId } from "./windowIds";
import { GpuWindowMap } from "./GpuWindow";

const buildConfig = await BuildConfig.get();

export type WindowOptionsType<T = undefined> = {
	title: string;
	frame: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
	url: string | null;
	html: string | null;
	preload: string | null;
	renderer: "native" | "cef";
	rpc?: T;
	styleMask?: {};
	// titleBarStyle options:
	// - 'default': normal titlebar with native window controls
	// - 'hidden': no titlebar, no native window controls (for fully custom chrome)
	// - 'hiddenInset': transparent titlebar with inset native controls
	titleBarStyle: "hidden" | "hiddenInset" | "default";
	// transparent: when true, window background is transparent (see-through)
	transparent: boolean;
	navigationRules: string | null;
	// Sandbox mode: when true, disables RPC and only allows event emission
	// Use for untrusted content (remote URLs) to prevent malicious sites from
	// accessing internal APIs, creating OOPIFs, or communicating with Bun
	sandbox: boolean;
	/** Whether to show the window immediately on creation. Default: true */
	show?: boolean;
};

const defaultOptions: WindowOptionsType = {
	title: "Electrobun",
	frame: {
		x: 0,
		y: 0,
		width: 800,
		height: 600,
	},
	url: "https://electrobun.dev",
	html: null,
	preload: null,
	renderer: buildConfig.defaultRenderer,
	titleBarStyle: "default",
	transparent: false,
	navigationRules: null,
	sandbox: false,
	show: true,
};

export const BrowserWindowMap: {
	[id: number]: BrowserWindow<RPCWithTransport>;
} = {};

// Clean up the window map when a window closes and optionally quit the app
electrobunEventEmitter.on("close", (event: { data: { id: number } }) => {
	const windowId = event.data.id;
	delete BrowserWindowMap[windowId];

	// Clean up all webviews associated with this window
	for (const view of BrowserView.getAll()) {
		if (view.windowId === windowId) {
			view.remove();
		}
	}

	const exitOnLastWindowClosed =
		buildConfig.runtime?.exitOnLastWindowClosed ?? true;

	if (
		exitOnLastWindowClosed &&
		Object.keys(BrowserWindowMap).length === 0 &&
		Object.keys(GpuWindowMap).length === 0
	) {
		quit();
	}
});

export class BrowserWindow<T extends RPCWithTransport = RPCWithTransport> {
	id: number = getNextWindowId();
	ptr!: Pointer;
	title: string = "Electrobun";
	state: "creating" | "created" = "creating";
	url: string | null = null;
	html: string | null = null;
	preload: string | null = null;
	renderer: "native" | "cef" = "native";
	transparent: boolean = false;
	navigationRules: string | null = null;
	// Sandbox mode disables RPC and only allows event emission (for untrusted content)
	sandbox: boolean = false;
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
	// todo (yoav): make this an array of ids or something
	webviewId!: number;

	constructor(options: Partial<WindowOptionsType<T>> = defaultOptions) {
		this.title = options.title || "New Window";
		this.frame = options.frame
			? { ...defaultOptions.frame, ...options.frame }
			: { ...defaultOptions.frame };
		this.url = options.url || null;
		this.html = options.html || null;
		this.preload = options.preload || null;
		this.renderer = options.renderer || defaultOptions.renderer;
		this.transparent = options.transparent ?? false;
		this.navigationRules = options.navigationRules || null;
		this.sandbox = options.sandbox ?? false;

		this.init({ ...options, show: options.show ?? defaultOptions.show });
	}

	init({
		rpc,
		styleMask,
		titleBarStyle,
		transparent,
		show,
	}: Partial<WindowOptionsType<T>>) {
		this.ptr = ffi.request.createWindow({
			id: this.id,
			title: this.title,
			url: this.url || "",
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
			show: show ?? true,
		}) as Pointer;

		BrowserWindowMap[this.id] = this;

		// todo (yoav): user should be able to override this and pass in their
		// own webview instance, or instances for attaching to the window.
		const webview = new BrowserView({
			// TODO: decide whether we want to keep sending url/html
			// here, if we're manually calling loadURL/loadHTML below
			// then we can remove it from the api here
			url: this.url,
			html: this.html,
			preload: this.preload,
			// frame: this.frame,
			renderer: this.renderer,
			frame: {
				x: 0,
				y: 0,
				width: this.frame.width,
				height: this.frame.height,
			},
			rpc,
			// todo: we need to send the window here and attach it in one go
			// then the view creation code in objc can toggle between offscreen
			// or on screen views depending on if windowId is null
			// does this mean browserView needs to track the windowId or handle it ephemerally?
			windowId: this.id,
			navigationRules: this.navigationRules,
			sandbox: this.sandbox,
		});

		console.log("setting webviewId: ", webview.id);

		this.webviewId = webview.id;
	}

	get webview() {
		// todo (yoav): we don't want this to be undefined, so maybe we should just
		// link directly to the browserview object instead of a getter
		return BrowserView.getById(this.webviewId) as BrowserView<T>;
	}

	static getById(id: number) {
		return BrowserWindowMap[id];
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
		// Update internal state
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

	// todo (yoav): move this to a class that also has off, append, prepend, etc.
	// name should only allow browserWindow events
	on(name: string, handler: (event: unknown) => void) {
		const specificName = `${name}-${this.id}`;
		electrobunEventEmitter.on(specificName, handler);
	}
}
