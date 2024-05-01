import { type RPCSchema } from "electrobun";

export type MyWebviewRPC = {
  bun: RPCSchema<{
    requests: {
      doMoreMath: {
        params: {
          a: number;
          b: number;
        };
        response: number;
      };
    };
    messages: {
      logToBun: {
        msg: string;
      };
    };
  }>;
  webview: RPCSchema<{
    requests: {
      doMath: {
        params: {
          a: number;
          b: number;
        };
        response: number;
      };
    };
    messages: {
      logToWebview: {
        msg: string;
      };
    };
  }>;
};

export type MyWebviewSyncRPC = {
  doSyncMath: (params: { a: number; b: number }) => number;
};
