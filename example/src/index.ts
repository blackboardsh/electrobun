import Electrobun, {BrowserWindow, type RPCSchema, createRPC} from 'electrobun/bun';

console.log('hi3')

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
    // url: 'https://eggbun.sh',
    
    // todo (yoav): should file:// scheme support be blocked in some cases?
    // url: 'file:///Users/yoav/Desktop/screen2.png',
    url: 'views://mainview/index.html',
    // preload should support a view:// or dynamic javascript content
    
    // preload: 'document.body.innerHTML += "hello from preload";',  
    frame: {
		width: 1800,
		height: 600,
		x: 2000,
		y: 2000,
    },
    rpc: myWebviewRPC
});


win2.setTitle('url browserwindow')


const win = new BrowserWindow({
    title: 'my url window',
    // preload: 'views://myextension/preload.js',  
    preload: 'views://mainview/index.js',  
    frame: {
		width: 1800,
		height: 600,
		x: 1000,
		y: 0,
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
        
        // todo (yoav): can we pass this to the webview's preload code so it doesn't have to be included
        // in the user's webview bundle?
        rpc: myWebviewRPC
        // <script src="asset://js/test.js"></script>
    // }
    
});


// todo (yoav): typescript types should resolve for e and e.setResponse
Electrobun.events.on('will-navigate', (e) => {
    console.log('example global will navigate handler', e.data.url, e.data.windowId )
    e.response = {allow: true};
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

// todo (yoav): why doesn't console.log log to the console? but console.timeEnd does?
console.log('-------> setting timeout\n\n\n\n\n')

setTimeout(() => {
    console.log('executing javascript')
    win.webview.executeJavascript('document.body.innerHTML = "wow yeah! . !";');
    win2.webview.executeJavascript('document.body.innerHTML = "wow yeah2! . !";');
    // win.webview.loadURL('https://google.com');
    // win.webview.sendMessageToWebview({msg: 'hello from bun'});
    setTimeout(() => {
        console.time('doMath')
        console.log('-------> do math')
        win.webview.rpc.request.doMath({a: 5, b: 3}).then((result) => {
            console.timeEnd('doMath')
            win2.webview.executeJavascript(`document.body.innerHTML += "------>do math result ${result}";`);
            console.log('doMath result', result);
            console.log('_+_+_+_+_+_+_+_+_+ doMath result', result);
        }).catch(err => {
            win2.webview.executeJavascript(`document.body.innerHTML += "------>do math error ${err.msg}";`);
            console.log('doMath error', err)
        
        })
    }, 1000)
}, 3000)

