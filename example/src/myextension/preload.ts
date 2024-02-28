import ElectrobunView, {createRPC } from 'electrobun/view'
import {type MyWebviewRPC} from './rpc';

const rpc = createRPC<MyWebviewRPC["webview"], MyWebviewRPC["bun"]>({    
    requestHandler: {
        getTitle: () => {            
            return document.title;            
        }
    }
});

const electrobun = new ElectrobunView.Electroview({rpc});

