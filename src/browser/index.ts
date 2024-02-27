import {type RPCSchema, type RPC, createRPC} from 'rpc-anywhere'


class Electroview {
    rpc?: RPC<any, any>;
    rpcHandler?: (msg: any) => void;

    constructor(config: {rpc: RPC<any, any>}) {
        this.rpc = config.rpc;

        this.init();
    }

    init() {
        // todo (yoav): rpc anywhere
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
                    document.body.innerHTML += "sending message to bun: " + messageString + '\n';
                    
                    that.bunBridge(messageString);
                } catch (error) {
                    document.body.innerHTML += "failed to serialize message to bun:  \n";
                    // console.error('bun: failed to serialize message to webview', error)
                }
            },
            registerHandler(handler) {
                that.rpcHandler = handler;
                
            }
        }
    
    }

    bunBridge(msg)  {
        document.body.innerHTML += "bunBRIDGE]\n" + msg;

        // todo (yoav): this should be happening in zig
        // if (msg[msg.length - 1] !== "\n") {
            // msg += "\n ";
        // }

        // document.body.innerHTML += "sending message to bun: [" + msg[msg.length - 1] + ']\n';
        // todo (yoav): rpc anywhere
        window.webkit.messageHandlers.bunBridge.postMessage(msg);
    }

    receiveMessageFromBun (msg)  {
        // NOTE: in the webview messages are passed by executing ElectrobunView.receiveMessageFromBun(object)
        // so they're already parsed into an object here
        document.body.innerHTML += "receiving message from bun"
        if (this.rpcHandler) {
            this.rpcHandler(msg);
        }

        // todo (yoav): rpc anywhere
        // if (typeof msg === 'string') {
        //     // todo (yoav): change this to console.log once devtools is working
        // document.body.innerHTML += msg;
        // } else {
        //     document.body.innerHTML = JSON.stringify(msg);
        // }
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






