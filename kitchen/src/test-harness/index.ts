// Test Harness - A bundled view that tests can use for RPC testing
import Electrobun, { Electroview } from "electrobun/view";
import type { RPCSchema } from "electrobun";

// Generic test harness RPC schema
export type TestHarnessRPC = {
  bun: RPCSchema<{
    requests: {
      // Echo back whatever is sent
      echo: {
        params: { value: any };
        response: any;
      };
      // Simple math
      add: {
        params: { a: number; b: number };
        response: number;
      };
      // Simulate error
      throwError: {
        params: { message?: string };
        response: void;
      };
      // Delayed response
      delayed: {
        params: { ms: number; value: any };
        response: any;
      };
    };
    messages: {
      ping: { timestamp: number };
    };
  }>;
  webview: RPCSchema<{
    requests: {
      // Get document info
      getDocumentTitle: {
        params: {};
        response: string;
      };
      // Math from webview
      multiply: {
        params: { a: number; b: number };
        response: number;
      };
      // Get a DOM element's text
      getElementText: {
        params: { selector: string };
        response: string | null;
      };
      // Set body content
      setBodyContent: {
        params: { html: string };
        response: void;
      };
    };
    messages: {
      pong: { timestamp: number };
    };
  }>;
};

// RPC setup with handlers for webview-side operations
const rpc = Electroview.defineRPC<TestHarnessRPC>({
  maxRequestTime: 30000,
  handlers: {
    requests: {
      getDocumentTitle: () => document.title,
      multiply: ({ a, b }) => a * b,
      getElementText: ({ selector }) => {
        const el = document.querySelector(selector);
        return el?.textContent || null;
      },
      setBodyContent: ({ html }) => {
        document.body.innerHTML = html;
      },
    },
    messages: {
      pong: ({ timestamp }) => {
        console.log(`Received pong at ${timestamp}`);
      },
    },
  },
});

const electrobun = new Electrobun.Electroview({ rpc });

// Expose for debugging
(window as any).electrobun = electrobun;
(window as any).testHarnessReady = true;

console.log("Test harness initialized");
