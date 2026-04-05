import type { RPCSchema } from "electrobun";

export type AppRPC = {
  bun: RPCSchema<{
    requests: {};
    messages: {
      ping: {
        params: {};
      };
    };
  }>;
  webview: RPCSchema<{
    requests: {};
  }>;
};
