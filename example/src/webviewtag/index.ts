import ElectrobunView, {Electroview } from 'electrobun/view'

const rpc = Electroview.defineRPC<any>({    
    handlers: {
        requests: {
            
        },
        messages: {
           
        
        }
    }
});


const electrobun = new ElectrobunView.Electroview({rpc});