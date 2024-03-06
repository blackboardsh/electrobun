import {type RPCSchema, type RPC, createRPC} from 'rpc-anywhere'

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






