import {
    type RPCSchema, 
  } from "rpc-anywhere";


// todo (yoav): move this stuff to browser/rpc/webview.ts
export type InternalWebviewHandlers = RPCSchema<{
    requests: {
      webviewTagCallAsyncJavaScript: {
        params: {
          messageId: string;
          webviewId: number;
          hostWebviewId: number;
          script: string;
        };
        response: void;
      };
    };
  }>;
  
  export type WebviewTagHandlers = RPCSchema<{
    requests: {};
    messages: {
      webviewTagResize: {
        id: number;
        frame: {
          x: number;
          y: number;
          width: number;
          height: number;
        };
        masks: string;
      };
      webviewTagUpdateSrc: {
        id: number;
        url: string;
      };
      webviewTagUpdateHtml: {
        id: number;
        html: string;
      }
      webviewTagGoBack: {
        id: number;
      };
      webviewTagGoForward: {
        id: number;
      };
      webviewTagReload: {
        id: number;
      };
      webviewTagRemove: {
        id: number;
      };
      startWindowMove: {
        id: number;
      };
      stopWindowMove: {
        id: number;
      };
      moveWindowBy: {
        id: number;
        x: number;
        y: number;
      };
      webviewTagSetTransparent: {
        id: number;
        transparent: boolean;
      };
      webviewTagSetPassthrough: {
        id: number;
        enablePassthrough: boolean;
      };
      webviewTagSetHidden: {
        id: number;
        hidden: boolean;
      };
      webviewTagSetNavigationRules: {
        id: number;
        rules: string[];
      };
      webviewTagFindInPage: {
        id: number;
        searchText: string;
        forward: boolean;
        matchCase: boolean;
      };
      webviewTagStopFind: {
        id: number;
      };
    };
  }>;
  