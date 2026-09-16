import { BrowserView } from "electrobun/main";
import type { AppRPC } from "./types";

const isDevelopment = process.env["NODE_ENV"] === "development";

export const rpcSchema = BrowserView.defineRPC<AppRPC>({
    handlers: {
        requests: {
            greet: () => {
                const message = `Hello, from the main procces`;
                console.log(message);
            },
            status: () => ({
                health: "OK",
                bunVersion: Bun.version,
                mode: isDevelopment ? "development" : "production",
            }),
        },
        messages: {},
    },
});
