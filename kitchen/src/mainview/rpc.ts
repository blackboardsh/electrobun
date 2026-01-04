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
      showMessageBoxDemo: {
        params: {
          type: "info" | "warning" | "error" | "question";
        };
        response: {
          clickedButton: number;
          buttonLabel: string;
        };
      };
      clipboardRead: {
        params: {};
        response: {
          text: string | null;
          formats: string[];
        };
      };
      clipboardWrite: {
        params: {
          text: string;
        };
        response: {
          success: boolean;
        };
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
