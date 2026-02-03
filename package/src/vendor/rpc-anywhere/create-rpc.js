import { _createRPC } from "./rpc.js";
/**
 * Creates an RPC instance that can send and receive requests, responses
 * and messages.
 */
export function createRPC(
/**
 * The options that will be used to configure the RPC instance.
 */
options) {
    return _createRPC(options);
}
/**
 * Creates an RPC instance as a client. The passed schema represents
 * the remote RPC's (server) schema.
 */
export function createClientRPC(
/**
 * The options that will be used to configure the RPC instance.
 */
options) {
    return _createRPC(options);
}
/**
 * Creates an RPC instance as a server. The passed schema represents
 * this RPC's (server) schema.
 */
export function createServerRPC(
/**
 * The options that will be used to configure the RPC instance.
 */
options) {
    return _createRPC(options);
}
