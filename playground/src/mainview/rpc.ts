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
      bigRequest: {
        params: string;
        response: string;
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
