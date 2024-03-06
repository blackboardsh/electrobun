import ElectrobunView, {createRPC } from 'electrobun/view'
import {type MyExtensionSchema} from './rpc';

const rpc = createRPC<MyExtensionSchema["webview"], MyExtensionSchema["bun"]>({    
    requestHandler: {
        getTitle: () => {                        
            return document.title;            
        }
    }
});

const electrobun = new ElectrobunView.Electroview({rpc});

