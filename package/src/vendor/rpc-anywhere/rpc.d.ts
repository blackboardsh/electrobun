import { type _RPCPacket, type RPCMessageHandlerFn, type RPCMessagePayload, type RPCMessagesProxy, type RPCRequestHandler, type RPCRequestResponse, type RPCRequestsProxy, type RPCSchema, type RPCTransport, type WildcardRPCMessageHandlerFn } from "./types.js";
type DebugHooks = {
    /**
     * A function that will be called when the RPC sends a low-level
     * message.
     */
    onSend?: (packet: _RPCPacket) => void;
    /**
     * A function that will be called when the RPC receives a low-level
     * message.
     */
    onReceive?: (packet: _RPCPacket) => void;
};
export type _RPCOptions<Schema extends RPCSchema> = {
    /**
     * A transport object that will be used to send and receive
     * messages. Setting the `send` function manually will override
     * the transport's `send` function.
     */
    transport?: RPCTransport;
    /**
     * The function that will be used to handle requests.
     */
    requestHandler?: RPCRequestHandler<Schema["requests"]>;
    /**
     * The maximum time to wait for a response to a request, in
     * milliseconds. If exceeded, the promise will be rejected.
     * @default 1000
     */
    maxRequestTime?: number;
    /**
     * A collection of optional functions that will be called when
     * the RPC sends or receives a low-level message. Useful for
     * debugging and logging.
     */
    _debugHooks?: DebugHooks;
};
export declare function _createRPC<Schema extends RPCSchema = RPCSchema, RemoteSchema extends RPCSchema = Schema>(
/**
 * The options that will be used to configure the RPC instance.
 */
options?: _RPCOptions<Schema>): {
    setTransport: (newTransport: RPCTransport) => void;
    setRequestHandler: (handler: RPCRequestHandler<Schema["requests"]>) => void;
    request: (<Method extends keyof RemoteSchema["requests"]>(method: Method, ...args: "params" extends keyof RemoteSchema["requests"][Method] ? undefined extends RemoteSchema["requests"][Method]["params"] ? [params?: RemoteSchema["requests"][Method]["params"] | undefined] : [params: RemoteSchema["requests"][Method]["params"]] : []) => Promise<RPCRequestResponse<RemoteSchema["requests"], Method>>) & RPCRequestsProxy<RemoteSchema["requests"]>;
    requestProxy: RPCRequestsProxy<RemoteSchema["requests"]>;
    send: (<Message extends keyof Schema["messages"]>(message: Message, ...args: void extends RPCMessagePayload<Schema["messages"], Message> ? [] : undefined extends RPCMessagePayload<Schema["messages"], Message> ? [payload?: RPCMessagePayload<Schema["messages"], Message> | undefined] : [payload: RPCMessagePayload<Schema["messages"], Message>]) => void) & RPCMessagesProxy<Schema["messages"]>;
    sendProxy: RPCMessagesProxy<Schema["messages"]>;
    addMessageListener: {
        (message: "*", listener: WildcardRPCMessageHandlerFn<RemoteSchema["messages"]>): void;
        <Message_1 extends keyof RemoteSchema["messages"]>(message: Message_1, listener: RPCMessageHandlerFn<RemoteSchema["messages"], Message_1>): void;
    };
    removeMessageListener: {
        (message: "*", listener: WildcardRPCMessageHandlerFn<RemoteSchema["messages"]>): void;
        <Message_2 extends keyof RemoteSchema["messages"]>(message: Message_2, listener: RPCMessageHandlerFn<RemoteSchema["messages"], Message_2>): void;
    };
    proxy: {
        send: RPCMessagesProxy<Schema["messages"]>;
        request: RPCRequestsProxy<RemoteSchema["requests"]>;
    };
    _setDebugHooks: (newDebugHooks: DebugHooks) => void;
};
export type RPCInstance<Schema extends RPCSchema = RPCSchema, RemoteSchema extends RPCSchema = Schema> = ReturnType<typeof _createRPC<Schema, RemoteSchema>>;
export {};
