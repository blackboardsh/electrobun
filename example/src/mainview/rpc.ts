import {type RPCSchema } from 'electrobun'

export type MyWebviewRPC = {
    bun: RPCSchema<{
        requests: {
            doMoreMath: {
                params: {
                    a: number,
                    b: number
                },
                response: number
            }
        },
        
    }>,
    webview:  RPCSchema<{
        messages: {
            logToBun: {                
                msg: string                
            }
        },
        requests: {
            doMath: {
                params: {
                    a: number,
                    b: number
                },
                response: number
            }
            
        }        
    }>
}