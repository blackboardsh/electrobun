import {type RPCSchema } from 'electrobun'

export type MyExtensionSchema = {
    bun: RPCSchema<{
        requests: {
            getTitle: {
                params: void,
                response: string
            }
        }   
    }>,
    webview:  RPCSchema<{
        
    }>
}