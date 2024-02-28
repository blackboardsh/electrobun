import {type RPCSchema } from 'electrobun'

export type MyExtensionSchema = {
    bun: RPCSchema<{
        requests: {
            getTitle: {
                args: {},
                returns: string
            }
        },       
    }>,
    webview:  RPCSchema<{}>
}