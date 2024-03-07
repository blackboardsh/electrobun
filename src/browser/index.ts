import {type RPCSchema, type RPCRequestHandler, type RPCOptions, type RPCMessageHandlerFn, type WildcardRPCMessageHandlerFn, createRPC} from 'rpc-anywhere'

interface ElectrobunWebviewRPCSChema {
    bun: RPCSchema,
    webview: RPCSchema
}


class Electroview<T> {
    rpc?: T;
    rpcHandler?: (msg: any) => void;

    constructor(config: {rpc: T}) {
        this.rpc = config.rpc;
        this.init();
    }

    init() {        
        window.__electrobun = {
            receiveMessageFromBun: this.receiveMessageFromBun.bind(this)
        }

        if (this.rpc) {
            this.rpc.setTransport(this.createTransport());;
        }
    }

    createTransport() {
        const that = this;
        return {
            send(message) {                
                try {
                    const messageString = JSON.stringify(message);                                        
                    that.bunBridge(messageString);
                } catch (error) {                    
                    console.error('bun: failed to serialize message to webview', error)
                }
            },
            registerHandler(handler) {
                that.rpcHandler = handler;                
            }
        }    
    }

    bunBridge(msg)  {        
        // Note: zig sets up this custom message handler bridge
        window.webkit.messageHandlers.bunBridge.postMessage(msg);
    }

    receiveMessageFromBun (msg)  {
        // NOTE: in the webview messages are passed by executing ElectrobunView.receiveMessageFromBun(object)
        // so they're already parsed into an object here
        document.body.innerHTML += "receiving message from bun"
        if (this.rpcHandler) {
            this.rpcHandler(msg);
        }        
    }
    // todo (yoav): This is mostly just the reverse of the one in BrowserView.ts on the bun side. Should DRY this up.
    static defineRPC<Schema extends ElectrobunWebviewRPCSChema, BunSchema extends RPCSchema = Schema["bun"], WebviewSchema extends RPCSchema = Schema["webview"]>(config: {
        maxRequestTime?: number,
        handlers: {            
            requests?: RPCRequestHandler<WebviewSchema["requests"]>,
            messages?:  {
                [key in keyof WebviewSchema["messages"]]: RPCMessageHandlerFn<WebviewSchema["messages"], key>
            } & {
                "*"?: WildcardRPCMessageHandlerFn<WebviewSchema["messages"]>
            },
        }
      }) {
        // Note: RPC Anywhere requires defining the requests that a schema handles and the messages that a schema sends.
        // eg: BunSchema { 
        //   requests: // ... requests bun handles, sent by webview
        //   messages: // ... messages bun sends, handled by webview
        // }
        // In some generlized contexts that makes sense,
        // In the Electrobun context it can feel a bit counter-intuitive so we swap this around a bit. In Electrobun, the
        // webview and bun are known endpoints so we simplify schema definitions by combining them.
        // Schema {
        //   bun: BunSchema {
        //      requests: // ... requests bun sends, handled by webview,
        //      messages: // ... messages bun sends, handled by webview
        //    },
        //   webview: WebviewSchema {
        //      requests: // ... requests webview sends, handled by bun,
        //      messages: // ... messages webview sends, handled by bun
        //    },
        // }
        // electrobun also treats messages as "requests that we don't wait for to complete", and normalizes specifying the
        // handlers for them alongside request handlers.

        type mixedWebviewSchema = {
            requests: BunSchema["requests"],
            messages: WebviewSchema["messages"]
        }

        type mixedBunSchema = {
            requests: WebviewSchema["requests"],
            messages: BunSchema["messages"]
        }

        const rpcOptions = {
            maxRequestTime: config.maxRequestTime,
            requestHandler: config.handlers.requests,                
            transport: {
                // Note: RPC Anywhere will throw if you try add a message listener if transport.registerHandler is falsey
                registerHandler: () => {},
            }
        } as RPCOptions<mixedBunSchema, mixedWebviewSchema>;        

        const rpc = createRPC<mixedBunSchema, mixedWebviewSchema>(rpcOptions);
        const messageHandlers = config.handlers.messages;
            if (messageHandlers) {
         // note: this can only be done once there is a transport
        // @ts-ignore - this is due to all the schema mixing we're doing, fine to ignore
        // while types in here are borked, they resolve correctly/bubble up to the defineRPC call site.
        rpc.addMessageListener('*', (messageName: keyof WebviewSchema["messages"], payload) => {
            
                

            const globalHandler = messageHandlers['*'];
            if (globalHandler) {
                globalHandler(messageName, payload);
            }
            
            const messageHandler = messageHandlers[messageName];
            if (messageHandler) {
                messageHandler(payload);            
            }            
        });
    }


        return rpc;
      }
}

export {
    type RPCSchema,
    createRPC,
    Electroview
}

const ElectrobunView = {
    Electroview
}

export default ElectrobunView






