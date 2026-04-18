import { CString, FFIType, JSCallback, ptr, toArrayBuffer, type Pointer } from "bun:ffi";

import { BuildConfig } from "./BuildConfig";
import { native, toCString } from "../proc/native";
import type { CustomScheme, CustomSchemePrivileges, ProtocolHandler } from "../../shared/protocol";

type ProtocolRequestMeta = {
	url: string;
	method: string;
	headers: [string, string][];
	hasBody: boolean;
};

type PendingProtocolRequest = {
	controller: AbortController;
	reader: ReadableStreamDefaultReader<Uint8Array> | null;
};

const RESERVED_SCHEMES = new Set([
	"http", "https", "file", "blob", "data", "about",
	"javascript", "chrome", "chrome-extension", "ftp", "ws", "wss",
]);

const DEFAULT_PRIVILEGES: Required<CustomSchemePrivileges> = {
	standard: true,
	secure: true,
	bypassCSP: false,
	allowServiceWorkers: false,
	supportFetchAPI: true,
	corsEnabled: true,
	stream: true,
	codeCache: false,
};

const declaredSchemes = new Map<string, CustomScheme & { privileges: Required<CustomSchemePrivileges> }>();
const protocolHandlers = new Map<string, ProtocolHandler>();
const pendingRequests = new Map<bigint, PendingProtocolRequest>();
const textEncoder = new TextEncoder();
let callbacksInstalled = false;
let schemesInitialized = false;
let schemesLoadedFromConfig = false;
let schemesInitPromise: Promise<void> | null = null;
let protocolRequestCallback: JSCallback | null = null;
let protocolCancelCallback: JSCallback | null = null;

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function normalizeScheme(scheme: string) {
	return scheme.trim().replace(/:$/, "").toLowerCase();
}

function assertValidScheme(scheme: string) {
	if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) {
		throw new Error(`Invalid protocol scheme: "${scheme}"`);
	}
	if (RESERVED_SCHEMES.has(scheme)) {
		throw new Error(
			`Protocol scheme '${scheme}' is reserved and cannot be registered as a custom protocol.`,
		);
	}
	if (scheme === "views") {
		throw new Error(`Protocol scheme 'views' is reserved by Electrobun for bundled assets.`);
	}
}

function resolvePrivileges(partial?: CustomSchemePrivileges): Required<CustomSchemePrivileges> {
	return { ...DEFAULT_PRIVILEGES, ...partial };
}

function syncNativeProtocolConfig() {
	const json = JSON.stringify([...declaredSchemes.values()]);
	if (native) {
		native.symbols.setCustomProtocolConfig(toCString(json));
	}
}

function loadDeclaredSchemes(buildConfigProtocols?: CustomScheme[]) {
	if (schemesInitialized) {
		return;
	}
	schemesInitialized = true;
	schemesLoadedFromConfig = true;

	const configured = Array.isArray(buildConfigProtocols) ? buildConfigProtocols : [];
	for (const entry of configured) {
		const scheme = normalizeScheme(entry.scheme);
		assertValidScheme(scheme);
		declaredSchemes.set(scheme, {
			scheme,
			privileges: resolvePrivileges(entry.privileges),
		});
	}

	syncNativeProtocolConfig();
}

async function ensureSchemesLoaded() {
	if (schemesInitialized) return;
	if (!schemesInitPromise) {
		schemesInitPromise = BuildConfig.get()
			.then((cfg) => loadDeclaredSchemes(cfg.protocols))
			.catch(() => { schemesInitialized = true; });
	}
	await schemesInitPromise;
}

function getRequestBody(requestId: bigint) {
	if (!native) {
		return null;
	}

	const sizeBuffer = new BigUint64Array(1);
	const dataPtr = native.symbols.protocolGetRequestBody(
		requestId,
		ptr(sizeBuffer),
	) as Pointer | null;

	if (!dataPtr) {
		return null;
	}

	const size = Number(sizeBuffer[0]);
	if (size === 0) {
		native.symbols.freeProtocolBuffer(dataPtr);
		return null;
	}

	const bytes = new Uint8Array(size);
	bytes.set(new Uint8Array(toArrayBuffer(dataPtr, 0, size)));
	native.symbols.freeProtocolBuffer(dataPtr);
	return bytes;
}

function serializeHeaders(headers: Headers, scheme: string) {
	const privileges = declaredSchemes.get(scheme)?.privileges ?? DEFAULT_PRIVILEGES;

	if (privileges.corsEnabled) {
		if (!headers.has("access-control-allow-origin")) {
			headers.set("access-control-allow-origin", "*");
		}
		if (!headers.has("access-control-allow-methods")) {
			headers.set("access-control-allow-methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
		}
		if (!headers.has("access-control-allow-headers")) {
			headers.set("access-control-allow-headers", "*");
		}
		if (!headers.has("access-control-expose-headers")) {
			headers.set("access-control-expose-headers", "*");
		}
	}

	const entries: Array<[string, string]> = [];
	headers.forEach((value, key) => {
		entries.push([key, value]);
	});
	return JSON.stringify(entries);
}

async function streamResponseBody(
	requestId: bigint,
	response: Response,
	pending: PendingProtocolRequest,
) {
	if (!response.body || NULL_BODY_STATUSES.has(response.status)) {
		if (native) {
			native.symbols.protocolFinishResponse(requestId);
		}
		return;
	}

	const reader = response.body.getReader();
	pending.reader = reader;

	try {
		while (true) {
			if (pending.controller.signal.aborted) {
				await reader.cancel();
				return;
			}

			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			if (native && value && value.byteLength > 0) {
				native.symbols.protocolWriteResponseChunk(requestId, ptr(value), BigInt(value.byteLength));
			}
		}

		if (native) {
			native.symbols.protocolFinishResponse(requestId);
		}
	} finally {
		pending.reader = null;
	}
}

async function dispatchProtocolRequest(
	requestId: bigint,
	_webviewId: number,
	meta: ProtocolRequestMeta,
) {
	const pending: PendingProtocolRequest = {
		controller: new AbortController(),
		reader: null,
	};
	pendingRequests.set(requestId, pending);

	try {
		const url = new URL(meta.url);
		const scheme = normalizeScheme(url.protocol);
		const handler = protocolHandlers.get(scheme);

		if (!handler) {
			if (native) {
				const body = textEncoder.encode("No handler registered for this protocol");
				native.symbols.protocolStartResponse(
					requestId,
					404,
					toCString("Not Found"),
					toCString(JSON.stringify([["content-type", "text/plain; charset=utf-8"]])),
				);
				native.symbols.protocolWriteResponseChunk(requestId, ptr(body), BigInt(body.byteLength));
				native.symbols.protocolFinishResponse(requestId);
			}
			return;
		}

		const body = meta.hasBody ? getRequestBody(requestId) : null;
		const init: RequestInit & { duplex?: "half" } = {
			method: meta.method,
			headers: meta.headers,
			signal: pending.controller.signal,
		};

		if (body && meta.method !== "GET" && meta.method !== "HEAD") {
			init.body = body;
		}

		const request = new Request(meta.url, init);
		const response = await handler(request);

		if (native) {
			native.symbols.protocolStartResponse(
				requestId,
				response.status,
				toCString(response.statusText || "OK"),
				toCString(serializeHeaders(response.headers, scheme)),
			);
		}

		await streamResponseBody(requestId, response, pending);
	} catch (error) {
		if (native) {
			native.symbols.protocolErrorResponse(
				requestId,
				toCString(error instanceof Error ? error.message : String(error)),
			);
		}
	} finally {
		pendingRequests.delete(requestId);
	}
}

function ensureCallbacksInstalled() {
	if (!native || callbacksInstalled) {
		return;
	}

	protocolRequestCallback = new JSCallback(
		(requestId: bigint, webviewId: number, requestJson: number) => {
			const jsonPointer = requestJson as unknown as Pointer;
			const json = new CString(jsonPointer).toString();
			native?.symbols.freeProtocolBuffer(jsonPointer);
			const meta = JSON.parse(json) as ProtocolRequestMeta;
			void dispatchProtocolRequest(requestId, webviewId, meta);
		},
		{
			args: [FFIType.u64, FFIType.u32, FFIType.cstring],
			returns: FFIType.void,
			threadsafe: true,
		},
	);

	protocolCancelCallback = new JSCallback(
		(requestId: bigint) => {
			const pending = pendingRequests.get(requestId);
			if (!pending) {
				return;
			}
			pending.controller.abort();
			void pending.reader?.cancel();
			pendingRequests.delete(requestId);
		},
		{
			args: [FFIType.u64],
			returns: FFIType.void,
			threadsafe: true,
		},
	);

	native.symbols.setCustomProtocolHandlers(protocolRequestCallback, protocolCancelCallback);
	callbacksInstalled = true;
}

export const Protocol = {
	async handle(scheme: string, handler: ProtocolHandler): Promise<void> {
		await ensureSchemesLoaded();

		const normalizedScheme = normalizeScheme(scheme);
		assertValidScheme(normalizedScheme);

		if (schemesLoadedFromConfig && !declaredSchemes.has(normalizedScheme)) {
			const declared = [...declaredSchemes.keys()];
			throw new Error(
				`Protocol scheme '${normalizedScheme}' is not declared in electrobun.config.ts. ` +
				`Declared schemes: [${declared.length ? declared.join(", ") : "none"}]`,
			);
		}

		if (protocolHandlers.has(normalizedScheme)) {
			console.warn(
				`[Protocol] handler for '${normalizedScheme}' is being replaced. ` +
				`Call Protocol.unhandle('${normalizedScheme}') first if this is intentional.`,
			);
		}

		protocolHandlers.set(normalizedScheme, handler);
		ensureCallbacksInstalled();
	},
	unhandle(scheme: string): boolean {
		return protocolHandlers.delete(normalizeScheme(scheme));
	},
	isHandled(scheme: string): boolean {
		return protocolHandlers.has(normalizeScheme(scheme));
	},
	getRegisteredSchemes(): CustomScheme[] {
		return [...declaredSchemes.values()];
	},
	getHandledSchemes(): string[] {
		return [...protocolHandlers.keys()];
	},
};
