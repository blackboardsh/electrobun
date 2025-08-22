import { BrowserWindow, BrowserView } from "electrobun/bun";
import { TestRunner } from "./test-runner";

// Define RPC schema for test communication
export type TestRPCSchema = {
  bun: {
    requests: {
      runTest: {
        params: { testId: string };
        response: { success: boolean; message: string };
      };
      getTestStatus: {
        params: {};
        response: { tests: any[] };
      };
      cleanup: {
        params: {};
        response: { success: boolean; message: string };
      };
    };
    messages: {
      testEvent: { testId: string; status: string; data: any };
    };
  };
  webview: {
    requests: {
      markTestResult: {
        params: { testId: string; passed: boolean; notes?: string };
        response: { acknowledged: boolean };
      };
    };
    messages: {
      showInstructions: { testId: string; instructions: string[] };
      updateStatus: { testId: string; status: string; details?: string };
    };
  };
};

const testRunner = new TestRunner();

// Create RPC handler
const testRPC = BrowserView.defineRPC<TestRPCSchema>({
  maxRequestTime: 5000,
  handlers: {
    requests: {
      runTest: async ({ testId }) => {
        const result = await testRunner.runTest(testId);
        return result;
      },
      getTestStatus: async () => {
        return {
          tests: testRunner.getAllTestStatus()
        };
      },
      cleanup: async () => {
        try {
          await testRunner.cleanup();
          return { success: true, message: 'Cleanup completed successfully' };
        } catch (error) {
          console.error('Cleanup failed:', error);
          return { success: false, message: `Cleanup failed: ${error}` };
        }
      }
    },
    messages: {
      markTestResult: ({ testId, passed, notes }) => {
        testRunner.markManualTestResult(testId, passed, notes);
        console.log(`Manual test ${testId}: ${passed ? 'PASSED' : 'FAILED'}${notes ? ` - ${notes}` : ''}`);
      }
    }
  }
});

// Create main test window
const mainWindow = new BrowserWindow({
  title: "Electrobun Test Harness",
  url: "views://mainview/index.html",
  renderer: "cef",
  frame: {
    x: 100,
    y: 100,
    width: 1200,
    height: 800
  },
  rpc: testRPC
});

// Set up test runner with main window reference
testRunner.setMainWindow(mainWindow);

// Initialize all tests
testRunner.initialize();

console.log("Electrobun Test Harness started");
console.log("Main window created, loading test interface...");

mainWindow.on("close", () => {
  console.log("Test harness closing, cleaning up...");
  testRunner.cleanup();
});