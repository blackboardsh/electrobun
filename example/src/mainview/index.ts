import ElectrobunView, {createRPC } from 'electrobun/view'
import {type MyWebviewRPC} from './rpc';

const rpc = createRPC<MyWebviewRPC["webview"], MyWebviewRPC["bun"]>({    
    requestHandler: {
        doMath: ({a, b}) => {
            document.body.innerHTML += `bun asked me to do math with ${a} and ${b}\n`;
            return a + b;
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

