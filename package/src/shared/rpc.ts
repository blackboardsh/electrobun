// ---- Wire protocol packets ----

type _RPCRequestPacket = {
	type: "request";
	id: number;
	method: string;
	params: any;
};

type _RPCResponsePacket =
	| { type: "response"; id: number; success: true; payload: any }
	| { type: "response"; id: number; success: false; error?: string };

type _RPCMessagePacket = {
	type: "message";
	id: string;
	payload: any;
};

type _RPCPacket = _RPCRequestPacket | _RPCResponsePacket | _RPCMessagePacket;

// ---- Schema primitives ----

type BaseRPCRequestsSchema = {
	[key: string]: { params: unknown; response: unknown };
};

export type RPCRequestsSchema<
	T extends BaseRPCRequestsSchema = BaseRPCRequestsSchema,
> = T;

type RPCRequestParams<
	RS extends RPCRequestsSchema,
	M extends keyof RS = keyof RS,
> = "params" extends keyof RS[M] ? RS[M]["params"] : never;

type RPCRequestResponse<
	RS extends RPCRequestsSchema,
	M extends keyof RS = keyof RS,
> = "response" extends keyof RS[M] ? RS[M]["response"] : void;

type BaseRPCMessagesSchema = Record<never, unknown>;

export type RPCMessagesSchema<
	T extends BaseRPCMessagesSchema = BaseRPCMessagesSchema,
> = T;

type RPCMessagePayload<
	MS extends RPCMessagesSchema,
	N extends keyof MS = keyof MS,
> = MS[N];

// ---- Composite schema ----

type InputRPCSchema = {
	requests?: RPCRequestsSchema;
	messages?: RPCMessagesSchema;
};

type ResolvedRPCSchema<I extends InputRPCSchema> = {
	requests: undefined extends I["requests"]
		? BaseRPCRequestsSchema
		: NonNullable<I["requests"]>;
	messages: undefined extends I["messages"]
		? BaseRPCMessagesSchema
		: NonNullable<I["messages"]>;
};

export type RPCSchema<
	I extends InputRPCSchema | void = InputRPCSchema,
> = ResolvedRPCSchema<I extends InputRPCSchema ? I : InputRPCSchema>;

// ---- Handler types ----

type RPCRequestHandlerFn<RS extends RPCRequestsSchema = RPCRequestsSchema> = <
	M extends keyof RS,
>(
	method: M,
	params: RPCRequestParams<RS, M>,
) => any | Promise<any>;

type RPCRequestHandlerObject<
	RS extends RPCRequestsSchema = RPCRequestsSchema,
> = {
	[M in keyof RS]?: (
		...args: "params" extends keyof RS[M]
			? undefined extends RS[M]["params"]
				? [params?: RS[M]["params"]]
				: [params: RS[M]["params"]]
			: []
	) =>
		| Awaited<RPCRequestResponse<RS, M>>
		| Promise<Awaited<RPCRequestResponse<RS, M>>>;
} & {
	_?: (method: keyof RS, params: RPCRequestParams<RS>) => any;
};

export type RPCRequestHandler<
	RS extends RPCRequestsSchema = RPCRequestsSchema,
> = RPCRequestHandlerFn<RS> | RPCRequestHandlerObject<RS>;

export type RPCMessageHandlerFn<
	MS extends RPCMessagesSchema,
	N extends keyof MS,
> = (payload: RPCMessagePayload<MS, N>) => void;

export type WildcardRPCMessageHandlerFn<MS extends RPCMessagesSchema> = (
	messageName: keyof MS,
	payload: RPCMessagePayload<MS>,
) => void;

// ---- Proxy types ----

type RPCRequestsProxy<RS extends RPCRequestsSchema> = {
	[K in keyof RS]: (
		...args: "params" extends keyof RS[K]
			? undefined extends RS[K]["params"]
				? [params?: RS[K]["params"]]
				: [params: RS[K]["params"]]
			: []
	) => Promise<RPCRequestResponse<RS, K>>;
};

type RPCMessagesProxy<MS extends RPCMessagesSchema> = {
	[K in keyof MS]-?: (
		...args: void extends MS[K]
			? []
			: undefined extends MS[K]
				? [payload?: MS[K]]
				: [payload: MS[K]]
	) => void;
};

// ---- Transport ----

type RPCTransportHandler = (data: any) => void;

export type RPCTransport = {
	send?: (data: any) => void;
	registerHandler?: (handler: RPCTransportHandler) => void;
	unregisterHandler?: () => void;
};

// ---- Options ----

type DebugHooks = {
	onSend?: (packet: _RPCPacket) => void;
	onReceive?: (packet: _RPCPacket) => void;
};

type _RPCAllOptions<S extends RPCSchema> = {
	transport?: RPCTransport;
	requestHandler?: RPCRequestHandler<S["requests"]>;
	maxRequestTime?: number;
	_debugHooks?: DebugHooks;
};

type RPCBaseOption = "transport" | "_debugHooks";
type RPCRequestsInOption = "requestHandler";
type RPCRequestsOutOption = "maxRequestTime";

type OptionsByLocalSchema<S extends RPCSchema> =
	NonNullable<unknown> extends S["requests"] ? never : RPCRequestsInOption;
type OptionsByRemoteSchema<RS extends RPCSchema> =
	NonNullable<unknown> extends RS["requests"] ? never : RPCRequestsOutOption;

export type RPCOptions<
	S extends RPCSchema,
	RS extends RPCSchema,
> = Pick<
	_RPCAllOptions<S>,
	RPCBaseOption | OptionsByLocalSchema<S> | OptionsByRemoteSchema<RS>
>;

// ---- createRPC ----

const MAX_ID = 1e10;
const DEFAULT_MAX_REQUEST_TIME = 1000;

function missingTransportMethodError(
	methods: string[],
	action: string,
): Error {
	const methodsString = methods.map((m) => `"${m}"`).join(", ");
	return new Error(
		`This RPC instance cannot ${action} because the transport did not provide one or more of these methods: ${methodsString}`,
	);
}

export function createRPC<
	Schema extends RPCSchema = RPCSchema,
	RemoteSchema extends RPCSchema = Schema,
>(options: _RPCAllOptions<Schema> = {}) {
	// ---- transport ----

	let debugHooks: DebugHooks = {};
	let transport: RPCTransport = {};
	let requestHandler:
		| RPCRequestHandlerFn<Schema["requests"]>
		| undefined = undefined;

	function setTransport(newTransport: RPCTransport) {
		if (transport.unregisterHandler) transport.unregisterHandler();
		transport = newTransport;
		transport.registerHandler?.(handler);
	}

	function setRequestHandler(
		h: RPCRequestHandler<Schema["requests"]>,
	) {
		if (typeof h === "function") {
			requestHandler = h as RPCRequestHandlerFn<Schema["requests"]>;
			return;
		}
		requestHandler = (method, params) => {
			const handlerFn = (h as RPCRequestHandlerObject<Schema["requests"]>)[
				method
			];
			if (handlerFn) return (handlerFn as any)(params);
			const fallbackHandler = (
				h as RPCRequestHandlerObject<Schema["requests"]>
			)._;
			if (!fallbackHandler)
				throw new Error(`The requested method has no handler: ${String(method)}`);
			return fallbackHandler(method, params as any);
		};
	}

	// ---- apply options ----

	const { maxRequestTime = DEFAULT_MAX_REQUEST_TIME } = options;
	if (options.transport) setTransport(options.transport);
	if (options.requestHandler) setRequestHandler(options.requestHandler);
	if (options._debugHooks) debugHooks = options._debugHooks;

	// ---- outgoing requests ----

	let lastRequestId = 0;
	function getRequestId() {
		if (lastRequestId <= MAX_ID) return ++lastRequestId;
		return (lastRequestId = 0);
	}

	const requestListeners = new Map<
		number,
		{ resolve: (v: any) => void; reject: (e: Error) => void }
	>();
	const requestTimeouts = new Map<number, ReturnType<typeof setTimeout>>();

	function requestFn<M extends keyof RemoteSchema["requests"]>(
		method: M,
		...args: "params" extends keyof RemoteSchema["requests"][M]
			? undefined extends RemoteSchema["requests"][M]["params"]
				? [params?: RemoteSchema["requests"][M]["params"]]
				: [params: RemoteSchema["requests"][M]["params"]]
			: []
	): Promise<RPCRequestResponse<RemoteSchema["requests"], M>> {
		const params = args[0];
		return new Promise((resolve, reject) => {
			if (!transport.send)
				throw missingTransportMethodError(["send"], "make requests");
			const requestId = getRequestId();
			const request: _RPCRequestPacket = {
				type: "request",
				id: requestId,
				method: method as string,
				params,
			};
			requestListeners.set(requestId, { resolve, reject });
			if (maxRequestTime !== Infinity)
				requestTimeouts.set(
					requestId,
					setTimeout(() => {
						requestTimeouts.delete(requestId);
						reject(new Error("RPC request timed out."));
					}, maxRequestTime),
				);
			debugHooks.onSend?.(request);
			transport.send(request);
		});
	}

	const request = new Proxy(requestFn, {
		get: (target, prop, receiver) => {
			if (prop in target) return Reflect.get(target, prop, receiver);
			return (params: any) => (requestFn as any)(prop, params);
		},
	}) as typeof requestFn & RPCRequestsProxy<RemoteSchema["requests"]>;

	const requestProxy =
		request as unknown as RPCRequestsProxy<RemoteSchema["requests"]>;

	// ---- outgoing messages ----

	function sendFn<M extends keyof Schema["messages"]>(
		message: M,
		...args: void extends RPCMessagePayload<Schema["messages"], M>
			? []
			: undefined extends RPCMessagePayload<Schema["messages"], M>
				? [payload?: RPCMessagePayload<Schema["messages"], M>]
				: [payload: RPCMessagePayload<Schema["messages"], M>]
	) {
		const payload = args[0];
		if (!transport.send)
			throw missingTransportMethodError(["send"], "send messages");
		const rpcMessage: _RPCMessagePacket = {
			type: "message",
			id: message as string,
			payload,
		};
		debugHooks.onSend?.(rpcMessage);
		transport.send(rpcMessage);
	}

	const send = new Proxy(sendFn, {
		get: (target, prop, receiver) => {
			if (prop in target) return Reflect.get(target, prop, receiver);
			return (payload: any) => (sendFn as any)(prop, payload);
		},
	}) as typeof sendFn & RPCMessagesProxy<Schema["messages"]>;

	const sendProxy =
		send as unknown as RPCMessagesProxy<Schema["messages"]>;

	// ---- incoming message listeners ----

	const messageListeners = new Map<string | symbol, Set<Function>>();
	const wildcardMessageListeners = new Set<Function>();

	function addMessageListener(
		message: "*",
		listener: WildcardRPCMessageHandlerFn<RemoteSchema["messages"]>,
	): void;
	function addMessageListener<
		M extends keyof RemoteSchema["messages"],
	>(
		message: M,
		listener: RPCMessageHandlerFn<RemoteSchema["messages"], M>,
	): void;
	function addMessageListener(message: any, listener: any) {
		if (!transport.registerHandler)
			throw missingTransportMethodError(
				["registerHandler"],
				"register message listeners",
			);
		if (message === "*") {
			wildcardMessageListeners.add(listener);
			return;
		}
		if (!messageListeners.has(message))
			messageListeners.set(message, new Set());
		messageListeners.get(message)!.add(listener);
	}

	function removeMessageListener(
		message: "*",
		listener: WildcardRPCMessageHandlerFn<RemoteSchema["messages"]>,
	): void;
	function removeMessageListener<
		M extends keyof RemoteSchema["messages"],
	>(
		message: M,
		listener: RPCMessageHandlerFn<RemoteSchema["messages"], M>,
	): void;
	function removeMessageListener(message: any, listener: any) {
		if (message === "*") {
			wildcardMessageListeners.delete(listener);
			return;
		}
		messageListeners.get(message)?.delete(listener);
		if (messageListeners.get(message)?.size === 0)
			messageListeners.delete(message);
	}

	// ---- incoming packet handler ----

	async function handler(message: _RPCPacket) {
		debugHooks.onReceive?.(message);
		if (!("type" in message))
			throw new Error("Message does not contain a type.");

		if (message.type === "request") {
			if (!transport.send || !requestHandler)
				throw missingTransportMethodError(
					["send", "requestHandler"],
					"handle requests",
				);
			const { id, method, params } = message;
			let response: _RPCResponsePacket;
			try {
				response = {
					type: "response",
					id,
					success: true,
					payload: await requestHandler(method as any, params),
				};
			} catch (error) {
				if (!(error instanceof Error)) throw error;
				response = {
					type: "response",
					id,
					success: false,
					error: error.message,
				};
			}
			debugHooks.onSend?.(response);
			transport.send(response);
			return;
		}

		if (message.type === "response") {
			const timeout = requestTimeouts.get(message.id);
			if (timeout != null) clearTimeout(timeout);
			const { resolve, reject } =
				requestListeners.get(message.id) ?? {};
			if (!message.success) reject?.(new Error(message.error));
			else resolve?.(message.payload);
			return;
		}

		if (message.type === "message") {
			for (const listener of wildcardMessageListeners)
				(listener as any)(message.id, message.payload);
			const listeners = messageListeners.get(message.id);
			if (!listeners) return;
			for (const listener of listeners) (listener as any)(message.payload);
			return;
		}

		throw new Error(
			`Unexpected RPC message type: ${(message as any).type}`,
		);
	}

	const proxy = { send: sendProxy, request: requestProxy };

	return {
		setTransport,
		setRequestHandler,
		request,
		requestProxy,
		send,
		sendProxy,
		addMessageListener,
		removeMessageListener,
		proxy,
	};
}

// ---- Electrobun combined schema ----

export interface ElectrobunRPCSchema {
	bun: RPCSchema;
	webview: RPCSchema;
}

export interface RPCWithTransport {
	setTransport: (transport: RPCTransport) => void;
}

export type ElectrobunRPCConfig<
	Schema extends ElectrobunRPCSchema,
	Side extends "bun" | "webview",
> = {
	maxRequestTime?: number;
	handlers: {
		requests?: RPCRequestHandler<Schema[Side]["requests"]>;
		messages?: {
			[K in keyof Schema[Side]["messages"]]?: RPCMessageHandlerFn<
				Schema[Side]["messages"],
				K
			>;
		} & {
			"*"?: WildcardRPCMessageHandlerFn<Schema[Side]["messages"]>;
		};
	};
};

// ---- defineElectrobunRPC ----

export function defineElectrobunRPC<
	Schema extends ElectrobunRPCSchema,
	Side extends "bun" | "webview" = "bun" | "webview",
>(
	_side: Side,
	config: ElectrobunRPCConfig<Schema, Side> & {
		extraRequestHandlers?: Record<string, Function>;
	},
) {
	// Determine the other side for outgoing calls
	type OtherSide = Side extends "bun" ? "webview" : "bun";

	// Local schema = what this side handles (incoming requests) + what the other side handles (outgoing messages)
	type LocalSchema = {
		requests: Schema[Side]["requests"];
		messages: Schema[OtherSide]["messages"];
	};

	// Remote schema = what the other side handles (outgoing requests) + what this side handles (incoming messages)
	type RemoteSchema = {
		requests: Schema[OtherSide]["requests"];
		messages: Schema[Side]["messages"];
	};

	const rpcOptions = {
		maxRequestTime: config.maxRequestTime,
		requestHandler: {
			...config.handlers.requests,
			...config.extraRequestHandlers,
		},
		transport: {
			// Provide a stub so addMessageListener doesn't throw before real transport is set
			registerHandler: () => {},
		},
	} as _RPCAllOptions<LocalSchema>;

	const rpc = createRPC<LocalSchema, RemoteSchema>(rpcOptions);

	const messageHandlers = config.handlers.messages;
	if (messageHandlers) {
		rpc.addMessageListener(
			"*" as any,
			((messageName: keyof Schema[Side]["messages"], payload: any) => {
				const globalHandler = (messageHandlers as any)["*"];
				if (globalHandler) {
					globalHandler(messageName, payload);
				}

				const messageHandler = (messageHandlers as any)[messageName];
				if (messageHandler) {
					messageHandler(payload);
				}
			}) as any,
		);
	}

	return rpc;
}
