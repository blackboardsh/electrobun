import { type RPCSchema } from "electrobun/view";

export type AppRPC = {
    bun: RPCSchema<{
        requests: {
            greet: {
                params: {};
                response: void;
            };
            status: {
                params: {};
                response: {
                    health: string;
                    bunVersion: string;
                    mode: "development" | "production";
                };
            };
        };
    }>;
    webview: RPCSchema<{
        requests: {};
        messages: {};
    }>;
};
