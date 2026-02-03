import { type EmptyRPCSchema, type RPC, type RPCOptions, type RPCSchema } from "./types.js";
/**
 * Creates an RPC instance that can send and receive requests, responses
 * and messages.
 */
export declare function createRPC<Schema extends RPCSchema = RPCSchema, RemoteSchema extends RPCSchema = Schema>(
/**
 * The options that will be used to configure the RPC instance.
 */
options?: RPCOptions<Schema, RemoteSchema>): RPC<Schema, RemoteSchema>;
/**
 * Creates an RPC instance as a client. The passed schema represents
 * the remote RPC's (server) schema.
 */
export declare function createClientRPC<RemoteSchema extends RPCSchema = RPCSchema>(
/**
 * The options that will be used to configure the RPC instance.
 */
options: RPCOptions<EmptyRPCSchema, RemoteSchema>): RPC<EmptyRPCSchema, RemoteSchema>;
/**
 * Creates an RPC instance as a server. The passed schema represents
 * this RPC's (server) schema.
 */
export declare function createServerRPC<Schema extends RPCSchema = RPCSchema>(
/**
 * The options that will be used to configure the RPC instance.
 */
options: RPCOptions<Schema, EmptyRPCSchema>): {
    setTransport: (newTransport: import("./types.js").RPCTransport) => void;
    setRequestHandler: (handler: import("./types.js").RPCRequestHandler<Schema["requests"]>) => void;
    request: (<Method extends never>(method: Method, ...args: "params" extends keyof {}[Method] ? undefined extends {}[Method]["params"] ? [params?: {}[Method]["params"] | undefined] : [params: {}[Method]["params"]] : []) => Promise<import("./types.js").RPCRequestResponse<{}, Method>>) & import("./types.js").RPCRequestsProxy<{}>;
    requestProxy: import("./types.js").RPCRequestsProxy<{}>;
    send: (<Message extends keyof Schema["messages"]>(message: Message, ...args: void extends import("./types.js").RPCMessagePayload<Schema["messages"], Message> ? [] : undefined extends import("./types.js").RPCMessagePayload<Schema["messages"], Message> ? [payload?: import("./types.js").RPCMessagePayload<Schema["messages"], Message> | undefined] : [payload: import("./types.js").RPCMessagePayload<Schema["messages"], Message>]) => void) & import("./types.js").RPCMessagesProxy<Schema["messages"]>;
    sendProxy: import("./types.js").RPCMessagesProxy<Schema["messages"]>;
    addMessageListener: {
        (message: "*", listener: import("./types.js").WildcardRPCMessageHandlerFn<{}>): void;
        <Message_1 extends never>(message: Message_1, listener: import("./types.js").RPCMessageHandlerFn<{}, Message_1>): void;
    };
    removeMessageListener: {
        (message: "*", listener: import("./types.js").WildcardRPCMessageHandlerFn<{}>): void;
        <Message_2 extends never>(message: Message_2, listener: import("./types.js").RPCMessageHandlerFn<{}, Message_2>): void;
    };
    proxy: {
        send: import("./types.js").RPCMessagesProxy<Schema["messages"]>;
        request: import("./types.js").RPCRequestsProxy<{}>;
    };
    _setDebugHooks: (newDebugHooks: {
        onSend?: ((packet: import("./types.js")._RPCPacket) => void) | undefined;
        onReceive?: ((packet: import("./types.js")._RPCPacket) => void) | undefined;
    }) => void;
};
