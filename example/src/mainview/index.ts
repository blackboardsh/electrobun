import ElectrobunView, {Electroview } from 'electrobun/view'
import {type MyWebviewRPC} from './rpc';

const rpc = Electroview.defineRPC<MyWebviewRPC>({    
    handlers: {
        requests: {
            doMath: ({a, b}) => {
                document.body.innerHTML += `bun asked me to do math with ${a} and ${b}\n`;
                return a + b;
            }
        },
        messages: {
            logToWebview: ({msg}) => {
                console.log(`bun asked me to logToWebview: ${msg}`);
            }
        
        }
    }
});

const electrobun = new ElectrobunView.Electroview({rpc});

setTimeout(() => {
    if (electrobun.rpc) {
        electrobun.rpc.request.doMoreMath({a: 9, b: 8}).then((result) => {
            document.body.innerHTML += `I asked bun to do more math and it said ${result}\n`;
        });

        electrobun.rpc.send.logToBun({msg: 'hello from webview'});
    }
}, 5000);

