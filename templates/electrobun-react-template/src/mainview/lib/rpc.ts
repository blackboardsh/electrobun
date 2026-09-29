import type { AppRPC } from "@shared/rpc/types";
import { Electroview } from "electrobun/view";

const webRpc = Electroview.defineRPC<AppRPC>({
    handlers: {
        requests: {},
        messages: {},
    },
});

new Electroview({ rpc: webRpc });

export function useRpc() {
    const handlerRpc = webRpc.request;
    return { handlerRpc };
}

export const handlerRpc = () => webRpc.request;
