import { type RPCSchema } from "electrobun";

export type PlaygroundRPC = {
  bun: RPCSchema<{
    requests: {
      // Window Management
      createWindow: {
        params: {
          width: number;
          height: number;
          x: number;
          y: number;
          frameless?: boolean;
          transparent?: boolean;
          alwaysOnTop?: boolean;
        };
        response: { id: number };
      };
      closeWindow: {
        params: number; // window id
        response: void;
      };
      focusWindow: {
        params: number; // window id
        response: void;
      };
      getWindowList: {
        params: void;
        response: Array<{ id: number; title: string }>;
      };
      
      // RPC Testing
      doMath: {
        params: { a: number; b: number; operation: string };
        response: number;
      };
      echoBigData: {
        params: string;
        response: string;
      };
      
      // Menu Operations
      createTray: {
        params: { title: string; image?: string };
        response: { id: number };
      };
      removeTray: {
        params: number; // tray id
        response: void;
      };
      showContextMenu: {
        params: { x: number; y: number };
        response: void;
      };
      
      // File Operations
      openFileDialog: {
        params: {
          multiple?: boolean;
          fileTypes?: string[];
          startingFolder?: string;
        };
        response: string[];
      };
      moveToTrash: {
        params: string; // file path
        response: void;
      };
      showInFinder: {
        params: string; // file path
        response: void;
      };
      
      // WebView Operations
      createWebView: {
        params: string; // url
        response: { id: number };
      };
      executeJSInWebView: {
        params: { id: number; script: string };
        response: any;
      };
      
      
    };
    messages: {};
  }>;
  
  webview: RPCSchema<{
    requests: {};
    messages: {
      // Messages from bun to webview
      windowCreated: { id: number; title: string };
      windowClosed: { id: number };
      windowFocused: { id: number };
      
      trayClicked: { id: number; action: string };
      menuClicked: { action: string };
      
      fileSelected: { paths: string[] };
      
      rpcTestResult: { operation: string; result: any; duration: number };
      
      systemEvent: { type: string; details: any };
      
      logMessage: { level: 'info' | 'warn' | 'error'; message: string };
    };
  }>;
};