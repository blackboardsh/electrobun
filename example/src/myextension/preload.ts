import ElectrobunView, {Electroview } from 'electrobun/view'
import {type MyExtensionSchema} from './rpc';

const rpc = Electroview.defineRPC<MyExtensionSchema>({    
    handlers: {
        requests: {
            getTitle: () => {                                        
                return document.title;            
            }
        }
    }
});

const electrobun = new ElectrobunView.Electroview({rpc});

