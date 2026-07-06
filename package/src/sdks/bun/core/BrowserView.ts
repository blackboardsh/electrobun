import { ffi } from "../proc/native";
import electrobunEventEmitter from "../events/eventEmitter";
import {
	type ElectrobunRPCSchema,
	type ElectrobunRPCConfig,
	type RPCWithTransport,
	defineElectrobunRPC,
} from "../../../shared/rpc.js";
import { BuildConfig } from "./BuildConfig";
import {
	sendMessageToWebviewViaSocket,
	removeSocketForWebview,
} from "./Socket";
import { randomBytes } from "crypto";
import { type Pointer } from "bun:ffi";

const BrowserViewMap: {
	[id: number]: BrowserView<any>;
} = {};

export type BrowserViewOptions<T = undefined> = {
	url: string | null;
	html: string | null;
	preload: string | null;
	viewsRoot: string | null;
	renderer: "native" | "cef";
	partition: string | null;
	frame: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
	rpc: T;
	hostWebviewId: number;
	autoResize: boolean;
	windowId: number;
	navigationRules: string | null;
	// Sandbox mode: when true, disables RPC and only allows event emission
	// Use for untrusted content (remote URLs) to prevent malicious sites from
	// accessing internal APIs, creating OOPIFs, or communicating with Bun
	sandbox: boolean;
	// Set transparent on the AbstractView at creation (before first paint)
	startTransparent: boolean;
	// Set passthrough on the AbstractView at creation (before first paint)
	startPassthrough: boolean;
	// renderer:
};

const buildConfig = BuildConfig.getSync();

const defaultOptions: Partial<BrowserViewOptions> = {
	url: null,
	html: null,
	preload: null,
	viewsRoot: null,
	renderer: buildConfig.defaultRenderer,
	frame: {
		x: 0,
		y: 0,
		width: 800,
		height: 600,
	},
};
export class BrowserView<T extends RPCWithTransport = RPCWithTransport> {
	id = 0;
	hostWebviewId?: number;
	windowId!: number;
	renderer!: "cef" | "native";
	url: string | null = null;
	html: string | null = null;
	preload: string | null = null;
	viewsRoot: string | null = null;
	partition: string | null = null;
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
	secretKey!: Uint8Array;
	rpc?: T;
	rpcHandler?: (msg: unknown) => void;
	navigationRules: string | null = null;
	// Sandbox mode disables RPC and only allows event emission (for untrusted content)
	sandbox: boolean = false;
	startTransparent: boolean = false;
	startPassthrough: boolean = false;
	isRemoved: boolean = false;

	get ptr(): Pointer | null {
		if (this.isRemoved) {
			return null;
		}
		return ffi.request.getWebviewPointer({ id: this.id }) as Pointer | null;
	}

	constructor(options: Partial<BrowserViewOptions<T>> = defaultOptions) {
		// const rpc = options.rpc;

		this.url = options.url || defaultOptions.url || null;
		this.html = options.html || defaultOptions.html || null;
		this.preload = options.preload || defaultOptions.preload || null;
		this.viewsRoot = options.viewsRoot || defaultOptions.viewsRoot || null;
		this.frame = {
			x: options.frame?.x ?? defaultOptions.frame!.x,
			y: options.frame?.y ?? defaultOptions.frame!.y,
			width: options.frame?.width ?? defaultOptions.frame!.width,
			height: options.frame?.height ?? defaultOptions.frame!.height,
		};
		this.rpc = options.rpc;
		this.secretKey = new Uint8Array(randomBytes(32));
		this.partition = options.partition || null;
		this.hostWebviewId = options.hostWebviewId;
		this.windowId = options.windowId ?? 0;
		this.autoResize = options.autoResize === false ? false : true;
		this.navigationRules = options.navigationRules || null;
		this.renderer = options.renderer ?? defaultOptions.renderer ?? "native";
		this.sandbox = options.sandbox ?? false;
		this.startTransparent = options.startTransparent ?? false;
		this.startPassthrough = options.startPassthrough ?? false;

		this.id = this.init() as number;
		BrowserViewMap[this.id] = this;

		// If HTML content was provided, load it after webview creation.
		if (this.html) {
			setTimeout(() => {
				this.loadHTML(this.html!);
			}, 100);
		}
	}

	init() {
		this.initializeRpcTransport();

		return ffi.request.createWebview({
			windowId: this.windowId,
			hostWebviewId: this.hostWebviewId ?? null,
			renderer: this.renderer,
			// todo: consider sending secretKey as base64
			secretKey: this.secretKey.toString(),
			partition: this.partition,
			// Only pass URL if no HTML content is provided to avoid conflicts
			url: this.html ? null : this.url,
			preload: this.preload,
			viewsRoot: this.viewsRoot,
			frame: {
				width: this.frame.width,
				height: this.frame.height,
				x: this.frame.x,
				y: this.frame.y,
			},
			autoResize: this.autoResize,
			navigationRules: this.navigationRules,
			sandbox: this.sandbox,
			startTransparent: this.startTransparent,
			startPassthrough: this.startPassthrough,
			// transparent is looked up from parent window in native.ts
		});
	}

	initializeRpcTransport() {
		if (!this.rpc) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			this.rpc = BrowserView.defineRPC({
				handlers: { requests: {}, messages: {} },
			}) as any;
		}

		this.rpc!.setTransport(this.createTransport());
	}

	sendHostMessageToWebviewViaExecute(jsonMessage: unknown) {
		const stringifiedMessage =
			typeof jsonMessage === "string"
				? jsonMessage
				: JSON.stringify(jsonMessage);
		// todo (yoav): make this a shared const with the browser api
		const wrappedMessage = `window.__electrobun.receiveMessageFromHost(${stringifiedMessage})`;
		this.executeJavascript(wrappedMessage);
	}

	sendInternalHostMessageViaExecute(jsonMessage: unknown) {
		const stringifiedMessage =
			typeof jsonMessage === "string"
				? jsonMessage
				: JSON.stringify(jsonMessage);
		// todo (yoav): make this a shared const with the browser api
		const wrappedMessage = `window.__electrobun.receiveInternalMessageFromHost(${stringifiedMessage})`;
		this.executeJavascript(wrappedMessage);
	}

	// Note: the OS has a buffer limit on named pipes. If we overflow it
	// it won't trigger the kevent for zig to read the pipe and we'll be stuck.
	// so we have to chunk it
	// TODO: is this still needed after switching from named pipes
	executeJavascript(js: string) {
		if (!this.ptr || this.isRemoved) {
			return;
		}
		ffi.request.evaluateJavascriptWithNoCompletion({ id: this.id, js });
	}

	loadURL(url: string) {
		this.url = url;
		ffi.request.loadURLInWebView({ id: this.id, url: this.url });
	}

	loadHTML(html: string) {
		this.html = html;

		if (this.renderer === "cef") {
			// For CEF, store HTML content in native map and use scheme handler
			ffi.request.setWebviewHTMLContent({ id: this.id, html });
			this.loadURL("views://internal/index.html");
		} else {
			// For WKWebView, load HTML content directly
			ffi.request.loadHTMLInWebView({ id: this.id, html });
		}
	}

	setNavigationRules(rules: string[]) {
		this.navigationRules = JSON.stringify(rules);
		const rulesJson = JSON.stringify(rules);
		ffi.request.setWebviewNavigationRules({ id: this.id, rulesJson });
	}

	findInPage(
		searchText: string,
		options?: { forward?: boolean; matchCase?: boolean },
	) {
		const forward = options?.forward ?? true;
		const matchCase = options?.matchCase ?? false;
		ffi.request.webviewFindInPage({
			id: this.id,
			searchText,
			forward,
			matchCase,
		});
	}

	stopFindInPage() {
		ffi.request.webviewStopFind({ id: this.id });
	}

	openDevTools() {
		ffi.request.webviewOpenDevTools({ id: this.id });
	}

	closeDevTools() {
		ffi.request.webviewCloseDevTools({ id: this.id });
	}

	toggleDevTools() {
		ffi.request.webviewToggleDevTools({ id: this.id });
	}

	/**
	 * Set the page zoom level (WebKit only, similar to browser zoom).
	 * @param zoomLevel - The zoom level (1.0 = 100%, 1.5 = 150%, etc.)
	 */
	setPageZoom(zoomLevel: number) {
		ffi.request.webviewSetPageZoom({ id: this.id, zoomLevel });
	}

	/**
	 * Get the current page zoom level.
	 * @returns The current zoom level (1.0 = 100%)
	 */
	getPageZoom(): number {
		return ffi.request.webviewGetPageZoom({ id: this.id }) as number;
	}

	// todo (yoav): move this to a class that also has off, append, prepend, etc.
	// name should only allow browserView events
	// Note: normalize event names to willNavigate instead of ['will-navigate'] to save
	// 5 characters per usage and allow minification to be more effective.
	on(
		name:
			| "will-navigate"
			| "did-navigate"
			| "did-navigate-in-page"
			| "did-commit-navigation"
			| "dom-ready"
			| "download-started"
			| "download-progress"
			| "download-completed"
			| "download-failed",
		handler: (event: unknown) => void,
	) {
		const specificName = `${name}-${this.id}`;
		electrobunEventEmitter.on(specificName, handler);
	}

	createTransport = () => {
		const that = this;

		return {
			send(message: any) {
				if (!that.ptr || that.isRemoved) {
					return;
				}
				const sentOverSocket = sendMessageToWebviewViaSocket(that.id, message);

				if (!sentOverSocket) {
					try {
						const messageString = JSON.stringify(message);
						that.sendHostMessageToWebviewViaExecute(messageString);
					} catch (error) {
						console.error("host: failed to serialize message to webview", error);
					}
				}
			},
			registerHandler(handler: (msg: unknown) => void) {
				if (that.isRemoved) {
					return;
				}
				that.rpcHandler = handler;
			},
		};
	};

	remove() {
		if (this.isRemoved) {
			return;
		}
		this.isRemoved = true;
		// Drop JS-side references first so late callbacks cannot target a stale view.
		delete BrowserViewMap[this.id];
		removeSocketForWebview(this.id);
		this.rpc?.setTransport({
			send() {},
			registerHandler() {},
			unregisterHandler() {},
		});
		this.rpcHandler = undefined;
		try {
			ffi.request.webviewRemove({ id: this.id });
		} catch (error) {
			console.error(`Error removing webview ${this.id}:`, error);
		}
	}

	static getById(id: number) {
		return BrowserViewMap[id];
	}

	// Core can create webviews before Bun has constructed a JS wrapper for them.
	// Use this in native/runtime paths that need to ensure a wrapper exists.
	static ensureWrapped<T extends RPCWithTransport = RPCWithTransport>(
		id: number,
		options: Partial<BrowserViewOptions<T>> = {},
	) {
		return (
			(BrowserViewMap[id] as BrowserView<T> | undefined) ??
			BrowserView.adoptExisting(id, options)
		);
	}

	static adoptExisting<T extends RPCWithTransport = RPCWithTransport>(
		id: number,
		options: Partial<BrowserViewOptions<T>> = {},
	) {
		const existing = BrowserViewMap[id] as BrowserView<T> | undefined;
		if (existing) {
			return existing;
		}

		const ptr = ffi.request.getWebviewPointer({ id }) as Pointer | null;
		if (!ptr) {
			return undefined;
		}

		const view = Object.create(BrowserView.prototype) as BrowserView<T>;
		view.id = id;
		view.hostWebviewId = options.hostWebviewId;
		view.windowId = options.windowId ?? 0;
		view.renderer = options.renderer ?? defaultOptions.renderer ?? "native";
		view.url = options.url ?? defaultOptions.url ?? null;
		view.html = options.html ?? defaultOptions.html ?? null;
		view.preload = options.preload ?? defaultOptions.preload ?? null;
		view.viewsRoot = options.viewsRoot ?? defaultOptions.viewsRoot ?? null;
		view.partition = options.partition ?? null;
		view.frame = {
			x: options.frame?.x ?? defaultOptions.frame!.x,
			y: options.frame?.y ?? defaultOptions.frame!.y,
			width: options.frame?.width ?? defaultOptions.frame!.width,
			height: options.frame?.height ?? defaultOptions.frame!.height,
		};
		view.secretKey = new Uint8Array(0);
		view.rpc = options.rpc;
		view.rpcHandler = undefined;
		view.autoResize = options.autoResize === false ? false : true;
		view.navigationRules = options.navigationRules ?? null;
		view.sandbox = options.sandbox ?? false;
		view.startTransparent = options.startTransparent ?? false;
		view.startPassthrough = options.startPassthrough ?? false;
		view.isRemoved = false;
		BrowserViewMap[id] = view as BrowserView<any>;
		return view;
	}

	static getAll() {
		return Object.values(BrowserViewMap);
	}

	static defineRPC<Schema extends ElectrobunRPCSchema>(
		config: ElectrobunRPCConfig<Schema, "bun">,
	) {
		return defineElectrobunRPC("bun", config);
	}
}
