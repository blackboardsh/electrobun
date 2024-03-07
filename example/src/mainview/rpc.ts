import {type RPCSchema } from 'electrobun'

export type MyWebviewRPC = {
    bun: RPCSchema<{
        requests: {
            doMath: {
                params: {
                    a: number,
                    b: number
                },
                response: number
            }            
        }             
        messages: {
            logToWebview: {                
                msg: string                
            }
        },
        
    }>,
    webview:  RPCSchema<{
        requests: {
            doMoreMath: {
                params: {
                    a: number,
                    b: number
                },
                response: number
            }
        },
        messages: {
            logToBun: {                
                msg: string                
            }
        },
           
    }>
}