import {type RPCSchema } from 'electrobun'

export type MyExtensionSchema = {
    bun: RPCSchema<{
        
    }>,
    webview:  RPCSchema<{
        requests: {
            getTitle: {
                params: void,
                response: string
            }
        }   
    }>
}