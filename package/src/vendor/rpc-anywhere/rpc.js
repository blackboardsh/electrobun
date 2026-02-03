const MAX_ID = 1e10;
const DEFAULT_MAX_REQUEST_TIME = 1000;
function missingTransportMethodError(methods, action) {
    const methodsString = methods.map((method) => `"${method}"`).join(", ");
    return new Error(`This RPC instance cannot ${action} because the transport did not provide one or more of these methods: ${methodsString}`);
}
export function _createRPC(
/**
 * The options that will be used to configure the RPC instance.
 */
options = {}) {
    // setters
    // -------
    let debugHooks = {};
    /**
     * Sets the debug hooks that will be used to debug the RPC instance.
     */
    function _setDebugHooks(newDebugHooks) {
        debugHooks = newDebugHooks;
    }
    let transport = {};
    /**
     * Sets the transport that will be used to send and receive requests,
     * responses and messages.
     */
    function setTransport(newTransport) {
        if (transport.unregisterHandler)
            transport.unregisterHandler();
        transport = newTransport;
        transport.registerHandler?.(handler);
    }
    let requestHandler = undefined;
    /**
     * Sets the function that will be used to handle requests from the
     * remote RPC instance.
     */
    function setRequestHandler(
    /**
     * The function that will be set as the "request handler" function.
     */
    handler) {
        if (typeof handler === "function") {
            requestHandler = handler;
            return;
        }
        requestHandler = (method, params) => {
            const handlerFn = handler[method];
            if (handlerFn)
                return handlerFn(params);
            const fallbackHandler = handler._;
            if (!fallbackHandler)
                throw new Error(`The requested method has no handler: ${method}`);
            return fallbackHandler(method, params);
        };
    }
    // options
    // -------
    const { maxRequestTime = DEFAULT_MAX_REQUEST_TIME } = options;
    if (options.transport)
        setTransport(options.transport);
    if (options.requestHandler)
        setRequestHandler(options.requestHandler);
    if (options._debugHooks)
        _setDebugHooks(options._debugHooks);
    // requests
    // --------
    let lastRequestId = 0;
    function getRequestId() {
        if (lastRequestId <= MAX_ID)
            return ++lastRequestId;
        return (lastRequestId = 0);
    }
    const requestListeners = new Map();
    const requestTimeouts = new Map();
    /**
     * Sends a request to the remote RPC endpoint and returns a promise
     * with the response.
     */
    function requestFn(method, ...args) {
        const params = args[0];
        return new Promise((resolve, reject) => {
            if (!transport.send)
                throw missingTransportMethodError(["send"], "make requests");
            const requestId = getRequestId();
            const request = {
                type: "request",
                id: requestId,
                method,
                params,
            };
            requestListeners.set(requestId, { resolve, reject });
            if (maxRequestTime !== Infinity)
                requestTimeouts.set(requestId, setTimeout(() => {
                    requestTimeouts.delete(requestId);
                    reject(new Error("RPC request timed out."));
                }, maxRequestTime));
            debugHooks.onSend?.(request);
            transport.send(request);
        });
    }
    /**
     * Sends a request to the remote RPC endpoint and returns a promise
     * with the response.
     *
     * It can also be used as a proxy to send requests by using the request
     * name as a property name.
     *
     * @example
     *
     * ```js
     * await rpc.request("methodName", { param: "value" });
     * // or
     * await rpc.request.methodName({ param: "value" });
     * ```
     */
    const request = new Proxy(requestFn, {
        get: (target, prop, receiver) => {
            if (prop in target)
                return Reflect.get(target, prop, receiver);
            // @ts-expect-error Not very important.
            return (params) => requestFn(prop, params);
        },
    });
    const requestProxy = request;
    // messages
    // --------
    function sendFn(
    /**
     * The name of the message to send.
     */
    message, ...args) {
        const payload = args[0];
        if (!transport.send)
            throw missingTransportMethodError(["send"], "send messages");
        const rpcMessage = {
            type: "message",
            id: message,
            payload,
        };
        debugHooks.onSend?.(rpcMessage);
        transport.send(rpcMessage);
    }
    /**
     * Sends a message to the remote RPC endpoint.
     *
     * It can also be used as a proxy to send messages by using the message
     * name as a property name.
     *
     * @example
     *
     * ```js
     * rpc.send("messageName", { content: "value" });
     * // or
     * rpc.send.messageName({ content: "value" });
     * ```
     */
    const send = new Proxy(sendFn, {
        get: (target, prop, receiver) => {
            if (prop in target)
                return Reflect.get(target, prop, receiver);
            // @ts-expect-error Not very important.
            return (payload) => sendFn(prop, payload);
        },
    });
    const sendProxy = send;
    const messageListeners = new Map();
    const wildcardMessageListeners = new Set();
    /**
     * Adds a listener for a message (or all if "*" is used) from the
     * remote RPC endpoint.
     */
    function addMessageListener(
    /**
     * The name of the message to listen to. Use "*" to listen to all
     * messages.
     */
    message, 
    /**
     * The function that will be called when a message is received.
     */
    listener) {
        if (!transport.registerHandler)
            throw missingTransportMethodError(["registerHandler"], "register message listeners");
        if (message === "*") {
            wildcardMessageListeners.add(listener);
            return;
        }
        if (!messageListeners.has(message))
            messageListeners.set(message, new Set());
        messageListeners.get(message)?.add(listener);
    }
    /**
     * Removes a listener for a message (or all if "*" is used) from the
     * remote RPC endpoint.
     */
    function removeMessageListener(
    /**
     * The name of the message to remove the listener for. Use "*" to
     * remove a listener for all messages.
     */
    message, 
    /**
     * The listener function that will be removed.
     */
    listener) {
        if (message === "*") {
            wildcardMessageListeners.delete(listener);
            return;
        }
        messageListeners.get(message)?.delete(listener);
        if (messageListeners.get(message)?.size === 0)
            messageListeners.delete(message);
    }
    // message handling
    // ----------------
    async function handler(message) {
        debugHooks.onReceive?.(message);
        if (!("type" in message))
            throw new Error("Message does not contain a type.");
        if (message.type === "request") {
            if (!transport.send || !requestHandler)
                throw missingTransportMethodError(["send", "requestHandler"], "handle requests");
            const { id, method, params } = message;
            let response;
            try {
                response = {
                    type: "response",
                    id,
                    success: true,
                    payload: await requestHandler(method, params),
                };
            }
            catch (error) {
                if (!(error instanceof Error))
                    throw error;
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
            if (timeout != null)
                clearTimeout(timeout);
            const { resolve, reject } = requestListeners.get(message.id) ?? {};
            if (!message.success)
                reject?.(new Error(message.error));
            else
                resolve?.(message.payload);
            return;
        }
        if (message.type === "message") {
            for (const listener of wildcardMessageListeners)
                listener(message.id, message.payload);
            const listeners = messageListeners.get(message.id);
            if (!listeners)
                return;
            for (const listener of listeners)
                listener(message.payload);
            return;
        }
        throw new Error(`Unexpected RPC message type: ${message.type}`);
    }
    // proxy
    // -----
    /**
     * A proxy object that can be used to send requests and messages.
     */
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
        _setDebugHooks,
    };
}
