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

const webviewTagCreatedEvent = Symbol("webview-tag-browser-view-created");

type QueuedWebviewMessage = {
	message: string;
	markSent: () => void;
	enqueuedAt: number;
	bytes: number;
};

const HOST_MESSAGE_SEND_BATCH_SIZE = 256;
const HOST_MESSAGE_SEND_BATCH_BYTES = 512 * 1024;
const HOST_MESSAGE_SEND_TURN_MS = 8;
const HOST_MESSAGE_SOCKET_AVAILABLE = process.platform !== "win32";
const HOST_MESSAGE_RESPONSE_PRIORITY = process.platform === "linux";

function isRpcResponsePacket(message: unknown): boolean {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { type?: unknown }).type === "response"
	);
}

export type BrowserViewOptions<T = undefined> = {
	url: string | null;
	html: string | null;
	preload: string | null;
	viewsRoot: string | null;
	allowedProtocols: {
		views?: boolean;
		appData?: boolean;
	};
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
	// Enables macOS system spell checking for native WKWebView content.
	// Unsupported renderers/platforms leave their behavior unchanged.
	spellCheck: boolean;
	// renderer:
};

export type BrowserViewCreatedHandler = (view: BrowserView) => void;

const buildConfig = BuildConfig.getSync();

const defaultOptions: Partial<BrowserViewOptions> = {
	url: null,
	html: null,
	preload: null,
	viewsRoot: null,
	allowedProtocols: { views: true, appData: false },
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
	allowedProtocols: { views: boolean; appData: boolean } = {
		views: true,
		appData: false,
	};
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
	hostMessageSendQueue: QueuedWebviewMessage[] = [];
	hostResponseSendQueue: QueuedWebviewMessage[] = [];
	flushingHostMessageSendQueue: boolean = false;
	private hostMessageQueuedBytes = 0;
	private hostMessageEnqueued = 0;
	private hostMessageDrained = 0;
	private hostMessagePeakQueuedBytes = 0;
	private hostMessagePeakQueuedCount = 0;
	navigationRules: string | null = null;
	// Sandbox mode disables RPC and only allows event emission (for untrusted content)
	sandbox: boolean = false;
	startTransparent: boolean = false;
	startPassthrough: boolean = false;
	spellCheck: boolean = false;
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
		this.allowedProtocols = {
			views: options.allowedProtocols?.views ?? true,
			appData: options.allowedProtocols?.appData ?? false,
		};
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
		this.spellCheck = options.spellCheck ?? false;

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
			allowedProtocols: this.allowedProtocols,
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
			spellCheck: this.spellCheck,
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

	private sendHostMessagesToWebviewViaExecute(jsonMessages: string[]) {
		if (jsonMessages.length === 0) return;

		const wrappedMessages = jsonMessages
			.map(
				(message) =>
					`window.__electrobun.receiveMessageFromHost(${message});`,
			)
			.join("\n");
		this.executeJavascript(wrappedMessages);
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

	/**
	 * Toggles macOS system spell checking for native WKWebView content.
	 * Returns false when the current renderer/platform does not support it.
	 */
	setSpellCheck(enabled: boolean): boolean {
		this.spellCheck = enabled;
		return ffi.request.webviewSetSpellCheck({ id: this.id, enabled });
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
				return that.queueHostMessageToWebview(message);
			},
			registerHandler(handler: (msg: unknown) => void) {
				if (that.isRemoved) {
					return;
				}
				that.rpcHandler = handler;
			},
		};
	};

	queueHostMessageToWebview(message: unknown): Promise<void> {
		return new Promise((markSent) => {
			if (!this.ptr || this.isRemoved) {
				markSent();
				return;
			}

			const queue =
				HOST_MESSAGE_RESPONSE_PRIORITY && isRpcResponsePacket(message)
					? this.hostResponseSendQueue
					: this.hostMessageSendQueue;
			// Serialize once when queued: retain the wire packet rather than its
			// potentially much larger application object graph.
			let serialized: string;
			try {
				serialized = JSON.stringify(message);
				if (serialized === undefined) throw new TypeError("RPC packet is not JSON serializable");
			} catch (error) {
				console.error("host: failed to serialize message to webview", error);
				markSent();
				return;
			}
			const bytes = Buffer.byteLength(serialized, "utf8");
			queue.push({ message: serialized, markSent, enqueuedAt: Date.now(), bytes });
			this.hostMessageQueuedBytes += bytes;
			this.hostMessageEnqueued++;
			this.hostMessagePeakQueuedBytes = Math.max(this.hostMessagePeakQueuedBytes, this.hostMessageQueuedBytes);
			this.hostMessagePeakQueuedCount = Math.max(this.hostMessagePeakQueuedCount, this.hostMessageSendQueue.length + this.hostResponseSendQueue.length);
			this.scheduleHostMessageFlush();
		});
	}

	private hasQueuedHostMessages() {
		return (
			this.hostResponseSendQueue.length > 0 ||
			this.hostMessageSendQueue.length > 0
		);
	}

	private takeQueuedHostMessageBatch() {
		const queue =
			this.hostResponseSendQueue.length > 0
				? this.hostResponseSendQueue
				: this.hostMessageSendQueue;
		let count = 0;
		let bytes = 0;
		while (count < queue.length && count < HOST_MESSAGE_SEND_BATCH_SIZE) {
			const nextBytes = queue[count]!.bytes;
			// A single oversized packet must still make progress.
			if (count > 0 && bytes + nextBytes > HOST_MESSAGE_SEND_BATCH_BYTES) break;
			bytes += nextBytes;
			count++;
		}
		this.hostMessageQueuedBytes -= bytes;
		this.hostMessageDrained += count;
		return queue.splice(0, count);
	}

	private scheduleHostMessageFlush() {
		if (this.flushingHostMessageSendQueue) return;

		this.flushingHostMessageSendQueue = true;
		queueMicrotask(() => void this.flushHostMessageSendQueue());
	}

	private sendQueuedHostMessageBatch(
		queuedMessages: QueuedWebviewMessage[],
	) {
		if (HOST_MESSAGE_SOCKET_AVAILABLE) {
			for (const queuedMessage of queuedMessages) {
				try {
					if (
						!sendMessageToWebviewViaSocket(
							this.id,
							queuedMessage.message,
							this.secretKey,
							true,
						)
					) {
						this.sendHostMessageToWebviewViaExecute(queuedMessage.message);
					}
				} catch (error) {
					console.error("host: failed to send message to webview", error);
				} finally {
					queuedMessage.markSent();
				}
			}
			return;
		}

		try {
			this.sendHostMessagesToWebviewViaExecute(
				queuedMessages.map(({ message }) => message),
			);
		} catch (error) {
			console.error("host: failed to send messages to webview", error);
		} finally {
			for (const { markSent } of queuedMessages) markSent();
		}
	}

	async flushHostMessageSendQueue() {
		try {
			let turnStarted = performance.now();
			while (this.hasQueuedHostMessages() && !this.isRemoved) {
				const batch = this.takeQueuedHostMessageBatch();
				this.sendQueuedHostMessageBatch(batch);

				if (this.hasQueuedHostMessages() && performance.now() - turnStarted >= HOST_MESSAGE_SEND_TURN_MS) {
					// Yield to I/O without paying Windows timer granularity after
					// every 32 packets. Limit each turn so input remains responsive.
					await new Promise<void>((resolve) => setImmediate(resolve));
					turnStarted = performance.now();
				}
			}
		} finally {
			this.flushingHostMessageSendQueue = false;
			if (this.isRemoved) {
				this.resolveQueuedHostMessages();
			} else if (this.hasQueuedHostMessages()) {
				this.scheduleHostMessageFlush();
			}
		}
	}

	/** Host queue only; bytes are serialized UTF-8, not retained heap size.
	 * Drained means handed to the native transport, not rendered by the WebView. */
	getHostMessageQueueStats() {
		const oldest = Math.min(
			this.hostMessageSendQueue[0]?.enqueuedAt ?? Infinity,
			this.hostResponseSendQueue[0]?.enqueuedAt ?? Infinity,
		);
		return {
			queuedMessages: this.hostMessageSendQueue.length + this.hostResponseSendQueue.length,
			queuedBytes: this.hostMessageQueuedBytes,
			oldestMessageAgeMs: Number.isFinite(oldest) ? Math.max(0, Date.now() - oldest) : 0,
			enqueuedMessages: this.hostMessageEnqueued,
			drainedMessages: this.hostMessageDrained,
			peakQueuedMessages: this.hostMessagePeakQueuedCount,
			peakQueuedBytes: this.hostMessagePeakQueuedBytes,
		};
	}

	private resolveQueuedHostMessages() {
		this.hostMessageQueuedBytes = 0;
		const responses = this.hostResponseSendQueue;
		const messages = this.hostMessageSendQueue;
		this.hostResponseSendQueue = [];
		this.hostMessageSendQueue = [];
		for (const entry of responses) entry.markSent();
		for (const entry of messages) entry.markSent();
	}

	remove() {
		if (this.isRemoved) {
			return;
		}
		this.isRemoved = true;
		this.resolveQueuedHostMessages();
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
		view.hostMessageSendQueue = [];
		view.hostResponseSendQueue = [];
		view.flushingHostMessageSendQueue = false;
		view.hostMessageQueuedBytes = 0;
		view.hostMessageEnqueued = 0;
		view.hostMessageDrained = 0;
		view.hostMessagePeakQueuedBytes = 0;
		view.hostMessagePeakQueuedCount = 0;
		view.autoResize = options.autoResize === false ? false : true;
		view.navigationRules = options.navigationRules ?? null;
		view.sandbox = options.sandbox ?? false;
		view.startTransparent = options.startTransparent ?? false;
		view.startPassthrough = options.startPassthrough ?? false;
		view.spellCheck = options.spellCheck ?? false;
		view.isRemoved = false;
		BrowserViewMap[id] = view as BrowserView<any>;
		return view;
	}

	static getAll() {
		return Object.values(BrowserViewMap);
	}

	/**
	 * Listen for BrowserViews created by <electrobun-webview> tags.
	 * The handler runs before the tag's initialization request resolves.
	 */
	static on(name: "created", handler: BrowserViewCreatedHandler) {
		electrobunEventEmitter.on(webviewTagCreatedEvent, handler);
		return () => BrowserView.off(name, handler);
	}

	static off(_name: "created", handler: BrowserViewCreatedHandler) {
		electrobunEventEmitter.off(webviewTagCreatedEvent, handler);
	}

	static defineRPC<Schema extends ElectrobunRPCSchema>(
		config: ElectrobunRPCConfig<Schema, "bun">,
	) {
		return defineElectrobunRPC("bun", config);
	}
}

// Internal lifecycle bridge used by webviewTagInit after the view is registered.
export function emitWebviewTagBrowserViewCreated(view: BrowserView) {
	electrobunEventEmitter.emit(webviewTagCreatedEvent, view);
}
