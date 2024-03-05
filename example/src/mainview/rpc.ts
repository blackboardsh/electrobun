import {type RPCSchema } from 'electrobun'

export type MyWebviewRPC = {
    bun: RPCSchema<{
        requests: {
            doMath: {
                params: {
                    a: number,
                    b: number
                },
                returns: number
            }
        },
        messages: {
            logToBun: {
                params: {
                    msg: string
                }
            }
        }
    }>,
    webview:  RPCSchema<{
        requests: {
            doMoreMath: {
                params: {
                    a: number,
                    b: number
                },
                returns: number
            }
        }        
    }>
}