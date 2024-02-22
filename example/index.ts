import Electrobun, {BrowserWindow, type RPCSchema, createRPC} from '../src/bun'


// todo (yoav): import this from a shared file (between dev's bun and webview)
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

const myWebviewRPC = createRPC<MyWebviewRPC["bun"], MyWebviewRPC["webview"]>({
    maxRequestTime: 5000,
    requestHandler: {
        doMoreMath: ({a, b}) => {
            console.log('doing more math in example/index.ts', a, b)
            return a + b;
        },
        log: (msg) => {
            console.log('log from webview', msg)
        }
    }
});




const win2 = new BrowserWindow({
    title: 'my url window',
    url: 'https://google.com',
    frame: {
		width: 1800,
		height: 600,
		x: 1000,
		y: 500,
    }
});


win2.setTitle('New title from bun')


const win = new BrowserWindow({
    title: 'my url window',
    frame: {
		width: 1800,
		height: 600,
		x: 1000,
		y: 500,
    },
    // webview: {
    // todo (yoav): break this into webview options
        html: `
        <html>
            <head></head>
            <body>
                <script>
                    // NOTE: do not use bunBridge.postMessage directly, if you forget the newline at the end
                    // it will break IPC
                    // window.webkit.messageHandlers.bunBridge.postMessage("Hello from JavaScript!");                
                    window.electrobun.bunBridge("Hello from bun bridge!");
                </script>
                <h1>hi</h1>
            </body>
        </html>
        `,
        
        rpc: myWebviewRPC
    // }
    
});


// todo (yoav): typescript types should resolve for e and e.setResponse
Electrobun.events.on('will-navigate', (e) => {
    console.log('example global will navigate handler', e.data.url, e.data.windowId )
    e.response = {allow: false};
})

win.webview.on('will-navigate', (e) => {
    console.log('example webview will navigate handler', e.data.url, e.data.windowId )
    if (e.responseWasSet && e.response.allow === false) {
        e.response.allow = true;
        // e.clearResponse();
    }    
})

// console.log('777777777777777777777', win.webview.rpc.request)

win.setTitle('New title from bun')

setTimeout(() => {
    win.webview.executeJavascript('document.body.innerHTML = "wow yeah! . !";');
    // win.webview.loadURL('https://google.com');
    // win.webview.sendMessageToWebview({msg: 'hello from bun'});
    setTimeout(() => {
        console.time('doMath')
        win.webview.rpc.request.doMath({a: 1, b: 2}).then((result) => {
            console.timeEnd('doMath')
            console.log('_+_+_+_+_+_+_+_+_+ doMath result', result);
        });
    }, 1000)
}, 3000)

