import {type RPCSchema, createRPC} from 'rpc-anywhere'

type MyWebviewRPC = {
    bun: RPCSchema<{
        requests: {
            doMath: {
                args: {
                    a: number,
                    b: number
                },
                returns: number
            }
        },
        messages: {
            hello: {
                args: {
                    msg: string
                }
            }
        }
    }>,
    webview:  RPCSchema<{
        requests: {
            doMoreMath: {
                args: {
                    a: number,
                    b: number
                },
                returns: number
            }
        },
        messages: {
            log: {
                args: {
                    msg: string
                }
            }
        }
    }>
}




class ElectrobunView {
    rpcHandler: any;

    bunBridge(msg)  {

        // document.body.innerHTML += "sending message to bun: [" + msg[msg.length - 1] + ']\n';

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
        this.rpcHandler(msg);

        // todo (yoav): rpc anywhere
        // if (typeof msg === 'string') {
        //     // todo (yoav): change this to console.log once devtools is working
        // document.body.innerHTML += msg;
        // } else {
        //     document.body.innerHTML = JSON.stringify(msg);
        // }
    }
}

const electrobun = new ElectrobunView();


const rpc = createRPC<MyWebviewRPC["webview"], MyWebviewRPC["bun"]>({
    transport: {
        send(message) {
            try {
                const messageString = JSON.stringify(message);
                document.body.innerHTML += "sending message to bun: " + messageString + '\n';
                
                electrobun.bunBridge(messageString);
            } catch (error) {
                document.body.innerHTML += "failed to serialize message to bun:  \n";
                // console.error('bun: failed to serialize message to webview', error)
            }
            
        },
        registerHandler(handler) {
            // todo (yoav): readStream function is identical to the one in zig.ts
            electrobun.rpcHandler = handler;
        }
    },
    requestHandler: {
        doMath: ({a, b}) => {
            document.body.innerHTML += "in do math handler\n" + a + ':::::' + b;
            // document.body.innerHTML += method + ' ' + params.a + ' ' + params.b + ' = ' + (params.a + params.b) + '\n';
            return a + b;
        }
    }

});






window.electrobun = electrobun;


