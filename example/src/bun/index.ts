import Electrobun, {BrowserWindow, BrowserView, type RPCSchema, createRPC} from 'electrobun/bun';
import {type MyWebviewRPC} from '../mainview/rpc';
import {type MyExtensionSchema} from '../myextension/rpc';

// const myWebviewRPC = createRPC<MyWebviewRPC["bun"], MyWebviewRPC["webview"]>({
//     maxRequestTime: 5000,
//     requestHandler: {
//         doMoreMath: ({a, b}) => {
//             console.log('\n\n\n\n')
//             console.log(`win1 webview asked me to do more math with: ${a} and ${b}`)            
//             return a + b;
//         },
//         // todo (yoav): messages currently require subscripting
//         // logToBun: ({msg}) => {
//         //     console.log('\n\nWebview asked to logToBun: ', msg, '\n\n')
//         // }
//     }
// });

const myWebviewRPC = BrowserView.defineRPC<MyWebviewRPC>({
    maxRequestTime: 5000,
    handlers: {
        requests: {
            doMoreMath: ({a, b}) => {
                console.log('\n\n\n\n')
                console.log(`win1 webview asked me to do more math with: ${a} and ${b}`)            
                return a + b;
            },
        },
        messages: {
            "*": (messageName, payload) => {
                console.log('----------.,.,.,.', messageName, payload)
            },
            logToBun: ({msg}) => {
                console.log('^^^^^^^^^^^^^^^^^^^^^^^^^------------............ received message', msg)
                    // console.log('\n\nWebview asked to logToBun: ', msg, '\n\n')
                }
        }
    }         
});

const win = new BrowserWindow({
    title: 'my url window',
    url: 'views://mainview/index.html',    
    frame: {
		width: 1800,
		height: 600,
		x: 2000,
		y: 2000,
    },
    rpc: myWebviewRPC
});


win.setTitle('url browserwindow')


const wikiWindow = new BrowserWindow({
    title: 'my url window',    
    url: 'https://en.wikipedia.org/wiki/Special:Random',
    preload: 'views://myextension/preload.js',  
    frame: {
		width: 1800,
		height: 600,
		x: 1000,
		y: 0,
    }, 
        // todo (yoav): can we pass this to the webview's preload code so it doesn't have to be included
        // in the user's webview bundle?
        // rpc: createRPC<MyExtensionSchema["bun"], MyExtensionSchema["webview"]>({
        //     maxRequestTime: 5000,
        //     // requestHandler: {}        
        // })         ,
        rpc: BrowserView.defineRPC<MyExtensionSchema>({
            maxRequestTime: 5000,
            handlers: {
                requests: {

                },
                messages: {

                }
            }
        })  
});

// wikiWindow.setRPC()


// todo (yoav): typescript types should resolve for e and e.setResponse
Electrobun.events.on('will-navigate', (e) => {
    console.log('example global will navigate handler', e.data.url, e.data.webviewId )
    e.response = {allow: true};
})

wikiWindow.webview.on('will-navigate', (e) => {
    console.log('example webview will navigate handler', e.data.url, e.data.webviewId )
    if (e.responseWasSet && e.response.allow === false) {
        e.response.allow = true;
        // e.clearResponse();
    }    
})

wikiWindow.setTitle('New title from bun')


setTimeout(() => {        
    win.webview.executeJavascript('document.body.innerHTML = "executing random js in win2 webview";');
    
    setTimeout(() => {        
        // asking wikipedia for the title of the article        
        wikiWindow.webview.rpc?.request.getTitle().then((result) => {
            console.log('\n\n\n\n')
            console.log(`visiting wikipedia article for: ${result}`)
            console.log('\n\n\n\n')
        }).catch(err => {            
            console.log('getTitle error', err)        
        })

        win.webview.rpc?.request.doMath({a: 3, b: 4}).then((result) => {
            console.log('\n\n\n\n')
            console.log(`I asked win1 webview to do math and it said: ${result}`)
            console.log('\n\n\n\n')
        });

        win.webview.rpc?.send.logToWebview({msg: 'hi from bun!'});
    }, 1000)
}, 3000)

