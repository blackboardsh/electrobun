// Electrobun Kitchen Sink - Integration Test Runner
// Run with: cd /electrobun/package && bun dev

import Electrobun, {
  BrowserWindow,
  BrowserView,
  ApplicationMenu,
  Utils,
} from "electrobun/bun";
import { executor } from "../test-framework/executor";
import { allTests } from "../tests";
import type { TestRunnerRPC } from "../test-runner/rpc";

console.log("\n");
console.log("╔════════════════════════════════════════════════════════════╗");
console.log("║       Electrobun Integration Test Runner                   ║");
console.log("╠════════════════════════════════════════════════════════════╣");
console.log("║  Run automated tests: Click 'Run All Automated' button    ║");
console.log("║  Run interactive tests: Click 'Run Interactive Tests'     ║");
console.log("║                                                            ║");
console.log("║  Auto-run tests: AUTO_RUN=1 electrobun dev                 ║");
console.log("║                                                            ║");
console.log("║  Results will appear both in the UI and in this terminal  ║");
console.log("╚════════════════════════════════════════════════════════════╝");
console.log("\n");

// Register all tests
executor.registerTests(allTests);

// Log test registration
const automated = executor.getAutomatedTests();
const interactive = executor.getInteractiveTests();
console.log(`Registered ${allTests.length} tests:`);
console.log(`  - ${automated.length} automated tests`);
console.log(`  - ${interactive.length} interactive tests`);
console.log("");

// Set up the application menu
ApplicationMenu.setApplicationMenu([
  {
    submenu: [
      { label: "Quit", role: "quit", accelerator: "q" },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  },
  {
    label: "Tests",
    submenu: [
      {
        label: "Run All Automated",
        action: "run-all-automated",
        accelerator: "CommandOrControl+R",
      },
      {
        label: "Run Interactive Tests",
        action: "run-interactive",
        accelerator: "CommandOrControl+Shift+R",
      },
    ],
  },
]);

Electrobun.events.on("application-menu-clicked", async (e) => {
  if (e.data.action === "run-all-automated") {
    await executor.runAllAutomated();
  } else if (e.data.action === "run-interactive") {
    await executor.runInteractiveTests();
  }
});

// Create the RPC for the test runner window
const testRunnerRPC = BrowserView.defineRPC<TestRunnerRPC>({
  maxRequestTime: 300000, // 5 minutes for long test runs
  handlers: {
    requests: {
      getTests: () => {
        return executor.getTests().map((t) => ({
          id: t.id,
          name: t.name,
          category: t.category,
          description: t.description,
          interactive: t.interactive,
        }));
      },

      runTest: async ({ testId }) => {
        const test = executor.getTests().find((t) => t.id === testId);
        if (!test) {
          throw new Error(`Test not found: ${testId}`);
        }
        return await executor.runTest(test);
      },

      runAllAutomated: async () => {
        return await executor.runAllAutomated();
      },

      runInteractiveTests: async () => {
        return await executor.runInteractiveTests();
      },

      submitInteractiveResult: ({ testId, passed, notes }) => {
        executor.submitInteractiveResult(testId, passed, notes);
      },

      submitReady: ({ testId }) => {
        executor.submitReady(testId);
      },

      submitVerification: ({ testId, action, notes }) => {
        executor.submitVerification(testId, action, notes);
      },
    },
    messages: {
      logToBun: ({ msg }) => {
        console.log("[UI]", msg);
      },
    },
  },
});

// Create the test runner window
const testRunnerWindow = new BrowserWindow({
  title: "Electrobun Integration Tests",
  url: "views://test-runner/index.html",
  renderer: "cef",
  frame: {
    width: 1000,
    height: 800,
    x: 100,
    y: 100,
  },
  rpc: testRunnerRPC,
});

// Keep test runner on top so results are visible while tests run
testRunnerWindow.setAlwaysOnTop(true);

// Forward test events to the UI
executor.onEvent((event) => {
  switch (event.type) {
    case "test-started":
      testRunnerWindow.webview.rpc?.send.testStarted({
        testId: event.testId!,
        name: event.name!,
      });
      break;

    case "test-completed":
      testRunnerWindow.webview.rpc?.send.testCompleted({
        testId: event.testId!,
        result: event.result!,
      });
      break;

    case "test-log":
      testRunnerWindow.webview.rpc?.send.testLog({
        testId: event.testId!,
        message: event.message!,
      });
      break;

    case "all-completed":
      testRunnerWindow.webview.rpc?.send.allCompleted({
        results: event.results!,
      });
      break;

    case "interactive-waiting":
      testRunnerWindow.webview.rpc?.send.interactiveWaiting({
        testId: event.testId!,
        instructions: event.instructions!,
      });
      break;

    case "interactive-ready":
      testRunnerWindow.webview.rpc?.send.interactiveReady({
        testId: event.testId!,
        instructions: event.instructions!,
      });
      break;

    case "interactive-verify":
      testRunnerWindow.webview.rpc?.send.interactiveVerify({
        testId: event.testId!,
      });
      break;
  }
});

// Handle window close
testRunnerWindow.on("close", () => {
  console.log("\nTest runner closed. Exiting...\n");
  process.exit(0);
});

// Print instructions
console.log("Test Runner window opened.");
console.log("Press Cmd+R to run all automated tests, or use the buttons in the UI.\n");

// Auto-run tests if AUTO_RUN environment variable is set
// Usage: AUTO_RUN=1 electrobun dev
const autoRun = process.env.AUTO_RUN === "1";
if (autoRun) {
  console.log("Auto-running automated tests in 3 seconds...\n");
  setTimeout(async () => {
    const results = await executor.runAllAutomated();
    
    // Exit with appropriate code when auto-run is complete
    const failedCount = results.filter(r => r.status === 'failed').length;
    const exitCode = failedCount > 0 ? 1 : 0;
    console.log(`\nAuto-run complete. Exiting with code ${exitCode}...`);
    
    // Give a moment for final logs to flush
    setTimeout(() => {
      process.exit(exitCode);
    }, 500);
  }, 3000);
}
