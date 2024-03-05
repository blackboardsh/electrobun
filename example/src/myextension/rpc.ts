import {type RPCSchema } from 'electrobun'

export type MyExtensionSchema = {
    bun: RPCSchema<{
        requests: {
            getTitle: {
                params: {},
                returns: string
            }
        },       
    }>,
    webview:  RPCSchema<{}>
}