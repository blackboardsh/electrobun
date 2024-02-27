import ElectrobunView, {type RPCSchema, createRPC } from 'electrobun/view'

// todo (yoav): users script file to go with js

console.log('script loaded into webview')

setTimeout(() => {
document.body.innerHTML += 'script loaded into webview'
}, 1000);

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


const rpc = createRPC<MyWebviewRPC["webview"], MyWebviewRPC["bun"]>({    
    requestHandler: {
        doMath: ({a, b}) => {
            document.body.innerHTML += "in do math handler\n" + a + ':::::' + b;
            // document.body.innerHTML += method + ' ' + params.a + ' ' + params.b + ' = ' + (params.a + params.b) + '\n';
            return a + b;
        }
    }

});

const electrobun = new ElectrobunView.Electroview({rpc});

setTimeout(() => {
    document.body.innerHTML += 'sending doMoreMath request\n';
    electrobun.rpc.request.doMoreMath({a: 9, b: 8}).then((result) => {
        document.body.innerHTML += '++++++++oMoreMath result: ' + result;
    });
}, 5000);

