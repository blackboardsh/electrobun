import { type _RPCOptions, type RPCInstance } from "./rpc.js";
/**
 * A low-level RPC message representing a request.
 */
export type _RPCRequestPacket<Method = any, Params = any> = {
    /**
     * The type of the message.
     */
    type: "request";
    /**
     * The ID of the request. Used to match responses to requests.
     */
    id: number;
    /**
     * The method to call.
     */
    method: Method;
    /**
     * The parameters to pass to the method.
     */
    params: Params;
};
/**
 * A low-level RPC message representing a response.
 */
export type _RPCResponsePacket<Payload = any> = {
    /**
     * The type of the message.
     */
    type: "response";
    /**
     * The ID of the request. Used to match responses to requests.
     */
    id: number;
    /**
     * Whether the request was successful.
     */
    success: true;
    /**
     * The response payload.
     */
    payload: Payload;
} | {
    /**
     * The type of the message.
     */
    type: "response";
    /**
     * The ID of the request. Used to match responses to requests.
     */
    id: number;
    /**
     * Whether the request was successful.
     */
    success: false;
    /**
     * The error message.
     */
    error?: string;
};
/**
 * A low-level RPC message representing a message.
 */
export type _RPCMessagePacket<Payload = any> = {
    /**
     * The type of the message.
     */
    type: "message";
    /**
     * The ID of the message. Also called "message name" in some contexts.
     */
    id: string;
    /**
     * The message payload.
     */
    payload: Payload;
};
/**
 * A low-level RPC message.
 */
export type _RPCPacket = _RPCRequestPacket | _RPCResponsePacket | _RPCMessagePacket;
type BaseRPCRequestsSchema = Record<never, {
    params?: unknown;
    response?: unknown;
}>;
/**
 * A schema for requests.
 */
export type RPCRequestsSchema<RequestsSchema extends BaseRPCRequestsSchema = BaseRPCRequestsSchema> = RequestsSchema;
/**
 * A utility type for getting the request params from a schema.
 * If a method is provided, it will return the params for that method.
 * Otherwise, it will return a union of params for all methods.
 */
export type RPCRequestParams<RequestsSchema extends RPCRequestsSchema, Method extends keyof RequestsSchema = keyof RequestsSchema> = "params" extends keyof RequestsSchema[Method] ? RequestsSchema[Method]["params"] : never;
/**
 * A utility type for getting the request response from a schema.
 * If a method is provided, it will return the response for that method.
 * Otherwise, it will return a union of responses for all methods.
 */
export type RPCRequestResponse<RequestsSchema extends RPCRequestsSchema, Method extends keyof RequestsSchema = keyof RequestsSchema> = "response" extends keyof RequestsSchema[Method] ? RequestsSchema[Method]["response"] : void;
/**
 * A utility type for getting the request low-level message from
 * a schema. If a method is provided, it will return the message
 * for that method. Otherwise, it will return a union of messages
 * for all methods.
 */
export type _RPCRequestPacketFromSchema<RequestsSchema extends RPCRequestsSchema, Method extends keyof RequestsSchema = keyof RequestsSchema> = _RPCRequestPacket<Method, RPCRequestParams<RequestsSchema, Method>>;
/**
 * A utility type for getting the response low-level message from
 * a schema. If a method is provided, it will return the message
 * for that method. Otherwise, it will return a union of messages
 * for all methods.
 */
export type _RPCResponsePacketFromSchema<RequestsSchema extends RPCRequestsSchema, Method extends keyof RequestsSchema = keyof RequestsSchema> = _RPCResponsePacket<RPCRequestResponse<RequestsSchema, Method>>;
/**
 * A request handler in "function" form.
 */
export type RPCRequestHandlerFn<RequestsSchema extends RPCRequestsSchema = RPCRequestsSchema> = <Method extends keyof RequestsSchema>(
/**
 * The method that has been called.
 */
method: Method, 
/**
 * The parameters that have been passed.
 */
params: RPCRequestParams<RequestsSchema, Method>) => any | Promise<any>;
/**
 * A request handler in "object" form.
 */
export type RPCRequestHandlerObject<RequestsSchema extends RPCRequestsSchema = RPCRequestsSchema> = {
    [Method in keyof RequestsSchema]?: (
    /**
     * The parameters that have been passed.
     */
    ...args: "params" extends keyof RequestsSchema[Method] ? undefined extends RequestsSchema[Method]["params"] ? [params?: RequestsSchema[Method]["params"]] : [params: RequestsSchema[Method]["params"]] : []) => Awaited<RPCRequestResponse<RequestsSchema, Method>> | Promise<Awaited<RPCRequestResponse<RequestsSchema, Method>>>;
} & {
    /**
     * A fallback method that will be called if no other method
     * matches the request.
     */
    _?: (
    /**
     * The method that has been called.
     */
    method: keyof RequestsSchema, 
    /**
     * The parameters that have been passed.
     */
    params: RPCRequestParams<RequestsSchema>) => any;
};
/**
 * A request handler.
 */
export type RPCRequestHandler<RequestsSchema extends RPCRequestsSchema = RPCRequestsSchema> = RPCRequestHandlerFn<RequestsSchema> | RPCRequestHandlerObject<RequestsSchema>;
type ParamsFromFunction<T extends (...args: any) => any> = Parameters<T> extends [] ? unknown : undefined extends Parameters<T>[0] ? {
    /**
     * The method's parameters.
     */
    params?: Parameters<T>[0];
} : {
    /**
     * The method's parameters.
     */
    params: Parameters<T>[0];
};
type ReturnFromFunction<T extends (...args: any) => any> = void extends ReturnType<T> ? unknown : {
    /**
     * The method's response payload.
     */
    response: Awaited<ReturnType<T>>;
};
type Flatten<T> = {
    [K in keyof T]: T[K];
};
type VoidIfEmpty<T> = T extends NonNullable<unknown> ? Flatten<T> : void;
type RequestDefinitionFromFunction<T extends (...args: any) => any> = VoidIfEmpty<ParamsFromFunction<T> & ReturnFromFunction<T>>;
/**
 * A utility type for getting the request schema from a request handler
 * created with `createRPCRequestHandler`.
 */
export type RPCRequestSchemaFromHandler<Handler extends RPCRequestHandlerObject> = {
    -readonly [Method in keyof Omit<Handler, "_"> as Handler[Method] extends (...args: any) => any ? Method : never]: Handler[Method] extends (...args: any) => any ? RequestDefinitionFromFunction<Handler[Method]> : never;
};
/**
 * A request proxy that allows calling requests as methods.
 */
export type RPCRequestsProxy<RequestsSchema extends RPCRequestsSchema> = {
    [K in keyof RequestsSchema]: (...args: "params" extends keyof RequestsSchema[K] ? undefined extends RequestsSchema[K]["params"] ? [params?: RequestsSchema[K]["params"]] : [params: RequestsSchema[K]["params"]] : []) => Promise<RPCRequestResponse<RequestsSchema, K>>;
};
type BaseRPCMessagesSchema = Record<never, unknown>;
/**
 * A schema for messages.
 */
export type RPCMessagesSchema<MessagesSchema extends BaseRPCMessagesSchema = BaseRPCMessagesSchema> = MessagesSchema;
/**
 * A utility type for getting the message payload from a schema.
 * If a message name is provided, it will return the payload for
 * that message. Otherwise, it will return a union of payloads
 * for all messages.
 */
export type RPCMessagePayload<MessagesSchema extends RPCMessagesSchema, MessageName extends keyof MessagesSchema = keyof MessagesSchema> = MessagesSchema[MessageName];
/**
 * A utility type for getting the message low-level message from
 * a schema. If a message name is provided, it will return the
 * message for that message. Otherwise, it will return a union
 * of messages for all messages.
 */
export type _RPCMessagePacketFromSchema<MessagesSchema extends RPCMessagesSchema, MessageName extends keyof MessagesSchema = keyof MessagesSchema> = _RPCMessagePacket<RPCMessagePayload<MessagesSchema, MessageName>>;
/**
 * A message handler for a specific message.
 */
export type RPCMessageHandlerFn<MessagesSchema extends RPCMessagesSchema, MessageName extends keyof MessagesSchema> = (payload: RPCMessagePayload<MessagesSchema, MessageName>) => void;
/**
 * A message handler for all messages.
 */
export type WildcardRPCMessageHandlerFn<MessagesSchema extends RPCMessagesSchema> = (messageName: keyof MessagesSchema, payload: RPCMessagePayload<MessagesSchema>) => void;
/**
 * A message proxy that allows sending messages through methods.
 */
export type RPCMessagesProxy<MessagesSchema extends RPCMessagesSchema> = {
    [K in keyof MessagesSchema]-?: (...args: void extends MessagesSchema[K] ? [] : undefined extends MessagesSchema[K] ? [payload?: MessagesSchema[K]] : [payload: MessagesSchema[K]]) => void;
};
type InputRPCSchema = {
    /**
     * A schema for requests.
     */
    requests?: RPCRequestsSchema;
    /**
     * A schema for messages.
     */
    messages?: RPCMessagesSchema;
};
type ResolvedRPCSchema<InputSchema extends InputRPCSchema, RequestHandler extends RPCRequestHandlerObject | undefined = undefined> = {
    /**
     * A schema for requests.
     */
    requests: RequestHandler extends RPCRequestHandlerObject ? RPCRequestSchemaFromHandler<RequestHandler> : undefined extends InputSchema["requests"] ? BaseRPCRequestsSchema : NonNullable<InputSchema["requests"]>;
    /**
     * A schema for messages.
     */
    messages: undefined extends InputSchema["messages"] ? BaseRPCMessagesSchema : NonNullable<InputSchema["messages"]>;
};
/**
 * A schema for requests and messages.
 */
export type RPCSchema<InputSchema extends InputRPCSchema | void = InputRPCSchema, RequestHandler extends RPCRequestHandlerObject | undefined = undefined> = ResolvedRPCSchema<InputSchema extends InputRPCSchema ? InputSchema : InputRPCSchema, RequestHandler>;
/**
 * An "empty" schema. Represents an RPC endpoint that doesn't
 * handle any requests or send any messages ("client").
 */
export type EmptyRPCSchema = RPCSchema;
export type RPCTransportHandler = (data: any) => void;
/**
 * A transport object that will be used to send and receive
 * messages.
 */
export type RPCTransport = {
    /**
     * The function that will be used to send requests, responses,
     * and messages.
     */
    send?: (data: any) => void;
    /**
     * The function that will be used to register a handler for
     * incoming requests, responses, and messages.
     */
    registerHandler?: (handler: RPCTransportHandler) => void;
    /**
     * The function that will be used to unregister the handler
     * (to clean up when replacing the transport).
     */
    unregisterHandler?: () => void;
};
type RPCBaseOption = "transport" | "_debugHooks";
type RPCRequestsInOption = "requestHandler";
type RPCRequestsOutOption = "maxRequestTime";
type OptionsByLocalSchema<Schema extends RPCSchema> = NonNullable<unknown> extends Schema["requests"] ? never : RPCRequestsInOption;
type OptionsByRemoteSchema<RemoteSchema extends RPCSchema> = NonNullable<unknown> extends RemoteSchema["requests"] ? never : RPCRequestsOutOption;
/**
 * Options for creating an RPC instance, tailored to a specific
 * set of schemas. Options will be ommitted if they are not
 * supported according to the schemas.
 *
 * For example, if the remote schema doesn't have a `requests`
 * property, the `maxRequestTime` option will be omitted because
 * the instance won't be able to send requests.
 */
export type RPCOptions<Schema extends RPCSchema, RemoteSchema extends RPCSchema> = Pick<_RPCOptions<Schema>, RPCBaseOption | OptionsByLocalSchema<Schema> | OptionsByRemoteSchema<RemoteSchema>>;
type RPCMethod = "setTransport";
type RPCRequestsInMethod = "setRequestHandler";
type RPCRequestsOutMethod = "request" | "requestProxy";
type RPCMessagesInMethod = "addMessageListener" | "removeMessageListener";
type RPCMessagesOutMethod = "send" | "sendProxy";
type RPCRequestsOutMessagesOutMethod = "proxy";
type MethodsByLocalSchema<Schema extends RPCSchema> = (NonNullable<unknown> extends Schema["requests"] ? never : RPCRequestsInMethod) | (NonNullable<unknown> extends Schema["messages"] ? never : RPCMessagesOutMethod);
type MethodsByRemoteSchema<RemoteSchema extends RPCSchema> = (NonNullable<unknown> extends RemoteSchema["requests"] ? never : RPCRequestsOutMethod) | (NonNullable<unknown> extends RemoteSchema["messages"] ? never : RPCMessagesInMethod);
type MethodsByRemoteSchemaAndLocalSchema<LocalSchema extends RPCSchema, RemoteSchema extends RPCSchema> = NonNullable<unknown> extends LocalSchema["messages"] ? never : NonNullable<unknown> extends RemoteSchema["requests"] ? never : RPCRequestsOutMessagesOutMethod;
/**
 * An RPC instance type, tailored to a specific set of schemas.
 * Methods will be ommitted if they are not supported according
 * to the schemas.
 *
 * For example, if the remote schema doesn't have a `requests`
 * property, the `request` method will be omitted because the
 * instance won't be able to send requests.
 */
export type RPC<Schema extends RPCSchema, RemoteSchema extends RPCSchema> = Pick<RPCInstance<Schema, RemoteSchema>, RPCMethod | MethodsByLocalSchema<Schema> | MethodsByRemoteSchema<RemoteSchema> | MethodsByRemoteSchemaAndLocalSchema<Schema, RemoteSchema>>;
export {};
