// Test executor - runs tests in the bun context

import { BrowserWindow, BrowserView } from "electrobun/bun";
import type {
  TestDefinition,
  TestResult,
  TestContext,
  TestWindow,
  WindowOptions,
  TestStatus,
  InteractiveResult,
} from "./types";

type TestEventHandler = (event: TestEvent) => void;

export interface TestEvent {
  type: 'test-started' | 'test-completed' | 'test-log' | 'all-completed' | 'interactive-waiting' | 'interactive-ready' | 'interactive-verify';
  testId?: string;
  name?: string;
  result?: TestResult;
  message?: string;
  instructions?: string[];
  results?: TestResult[];
}

export class TestExecutor {
  private tests: TestDefinition[] = [];
  private results: Map<string, TestResult> = new Map();
  private eventHandlers: TestEventHandler[] = [];
  private testWindows: Map<string, TestWindow[]> = new Map();
  private interactiveResolver: ((result: { passed: boolean; notes?: string }) => void) | null = null;
  private readyResolver: (() => void) | null = null;
  private verificationResolver: ((result: InteractiveResult) => void) | null = null;
  private currentTestId: string | null = null;

  constructor() {}

  registerTests(tests: TestDefinition[]) {
    this.tests.push(...tests);
  }

  getTests(): TestDefinition[] {
    return this.tests;
  }

  getAutomatedTests(): TestDefinition[] {
    return this.tests.filter(t => !t.interactive);
  }

  getInteractiveTests(): TestDefinition[] {
    return this.tests.filter(t => t.interactive);
  }

  getTestsByCategory(): Map<string, TestDefinition[]> {
    const byCategory = new Map<string, TestDefinition[]>();
    for (const test of this.tests) {
      const existing = byCategory.get(test.category) || [];
      existing.push(test);
      byCategory.set(test.category, existing);
    }
    return byCategory;
  }

  onEvent(handler: TestEventHandler) {
    this.eventHandlers.push(handler);
  }

  private emit(event: TestEvent) {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (e) {
        console.error('Error in test event handler:', e);
      }
    }
  }

  // Submit result for interactive test (legacy)
  submitInteractiveResult(testId: string, passed: boolean, notes?: string) {
    if (this.interactiveResolver && this.currentTestId === testId) {
      this.interactiveResolver({ passed, notes });
      this.interactiveResolver = null;
    }
  }

  // User clicked "Start" after reading instructions
  submitReady(testId: string) {
    if (this.readyResolver && this.currentTestId === testId) {
      this.readyResolver();
      this.readyResolver = null;
    }
  }

  // User submitted verification result (pass/fail/retest)
  submitVerification(testId: string, action: 'pass' | 'fail' | 'retest', notes?: string) {
    if (this.verificationResolver && this.currentTestId === testId) {
      this.verificationResolver({ action, notes });
      this.verificationResolver = null;
    }
  }

  private createTestContext(testId: string): TestContext {
    const logs: string[] = [];
    const windows: TestWindow[] = [];
    this.testWindows.set(testId, windows);

    return {
      createWindow: async (options: WindowOptions): Promise<TestWindow> => {
        const win = new BrowserWindow({
          title: options.title || `Test: ${testId}`,
          url: options.url || undefined,
          html: options.html || undefined,
          preload: options.preload || undefined,
          renderer: options.renderer || 'cef', // Default to CEF, allow override
          frame: {
            width: options.width || 800,
            height: options.height || 600,
            x: options.x ?? 100,
            y: options.y ?? 100,
          },
          rpc: options.rpc,
          titleBarStyle: options.titleBarStyle,
        });

        // Wait a bit for window to be created
        await new Promise(resolve => setTimeout(resolve, 100));

        const testWindow: TestWindow = {
          id: win.id,
          webviewId: win.webviewId,
          window: win,
          webview: win.webview,
          close: () => win.close(),
        };

        windows.push(testWindow);
        return testWindow;
      },

      log: (message: string) => {
        logs.push(message);
        const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
        console.log(`  [${timestamp}] ${message}`);
        this.emit({ type: 'test-log', testId, message });
      },

      // Show instructions and wait for user to click "Start"
      showInstructions: async (instructions: string[]): Promise<void> => {
        this.emit({ type: 'interactive-ready', testId, instructions });
        this.currentTestId = testId;

        return new Promise((resolve) => {
          this.readyResolver = resolve;
        });
      },

      // Wait for user to verify the result (pass/fail/retest)
      waitForUserVerification: async (): Promise<InteractiveResult> => {
        this.emit({ type: 'interactive-verify', testId });

        return new Promise((resolve) => {
          this.verificationResolver = resolve;
        });
      },

      // Legacy - combines show + verify
      waitForUserAction: async (instructions: string[]): Promise<{ passed: boolean; notes?: string }> => {
        this.emit({ type: 'interactive-waiting', testId, instructions });

        return new Promise((resolve) => {
          this.interactiveResolver = resolve;
          this.currentTestId = testId;
        });
      },
    };
  }

  private async cleanupTestWindows(testId: string) {
    const windows = this.testWindows.get(testId) || [];
    for (const win of windows) {
      try {
        // Check if window still exists before closing
        if (win.window && typeof win.window.close === 'function') {
          win.close();
        }
      } catch (e) {
        // Window might already be closed or destroyed
        console.debug(`Cleanup: Window ${win.id} already closed or invalid:`, e.message);
      }
    }
    this.testWindows.delete(testId);
    
    // Add delay to let CEF/WebKit finish async cleanup before next test
    // This prevents X11 race conditions when tests run back-to-back
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  async runTest(test: TestDefinition): Promise<TestResult> {
    const startTime = Date.now();
    const logs: string[] = [];

    console.log(`\n  Running: ${test.name}`);
    this.emit({ type: 'test-started', testId: test.id, name: test.name });

    const context = this.createTestContext(test.id);

    try {
      // Run with timeout
      await Promise.race([
        test.run(context),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Test timed out after ${test.timeout}ms`)), test.timeout)
        ),
      ]);

      const result: TestResult = {
        testId: test.id,
        name: test.name,
        status: 'passed',
        duration: Date.now() - startTime,
        logs,
      };

      this.results.set(test.id, result);
      console.log(`  \x1b[32m✓ PASSED\x1b[0m (${result.duration}ms)`);
      this.emit({ type: 'test-completed', testId: test.id, result });
      return result;
    } catch (error: any) {
      const result: TestResult = {
        testId: test.id,
        name: test.name,
        status: 'failed',
        duration: Date.now() - startTime,
        error: error.message || String(error),
        logs,
      };

      this.results.set(test.id, result);
      console.log(`  \x1b[31m✗ FAILED\x1b[0m: ${result.error}`);
      this.emit({ type: 'test-completed', testId: test.id, result });
      return result;
    } finally {
      await this.cleanupTestWindows(test.id);
    }
  }

  async runAllAutomated(): Promise<TestResult[]> {
    const automated = this.getAutomatedTests();
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Running ${automated.length} automated tests...`);
    console.log(`${'='.repeat(60)}`);

    const results: TestResult[] = [];

    // Group by category
    const byCategory = new Map<string, TestDefinition[]>();
    for (const test of automated) {
      const existing = byCategory.get(test.category) || [];
      existing.push(test);
      byCategory.set(test.category, existing);
    }

    // Run tests by category
    for (const [category, tests] of byCategory) {
      console.log(`\n\x1b[36m[${category}]\x1b[0m`);

      // Run tests in this category sequentially to avoid resource exhaustion
      // Running 30+ CEF browser instances in parallel causes crashes on Linux
      for (const test of tests) {
        const result = await this.runTest(test);
        results.push(result);
      }
    }

    // Summary
    const passed = results.filter(r => r.status === 'passed').length;
    const failed = results.filter(r => r.status === 'failed').length;

    console.log(`\n${'='.repeat(60)}`);
    if (failed === 0) {
      console.log(`\x1b[32mAll ${passed} automated tests passed!\x1b[0m`);
    } else {
      console.log(`\x1b[31m${failed} failed\x1b[0m, \x1b[32m${passed} passed\x1b[0m`);
      console.log('\nFailed tests:');
      for (const result of results.filter(r => r.status === 'failed')) {
        console.log(`  - ${result.name}: ${result.error}`);
      }
    }
    console.log(`${'='.repeat(60)}\n`);

    this.emit({ type: 'all-completed', results });
    return results;
  }

  async runInteractiveTests(): Promise<TestResult[]> {
    const interactive = this.getInteractiveTests();
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Running ${interactive.length} interactive tests...`);
    console.log(`${'='.repeat(60)}`);

    const results: TestResult[] = [];

    for (const test of interactive) {
      const result = await this.runTest(test);
      results.push(result);
    }

    return results;
  }

  getResults(): TestResult[] {
    return Array.from(this.results.values());
  }

  getSummary(): { total: number; passed: number; failed: number; pending: number } {
    const results = this.getResults();
    return {
      total: this.tests.length,
      passed: results.filter(r => r.status === 'passed').length,
      failed: results.filter(r => r.status === 'failed').length,
      pending: this.tests.length - results.length,
    };
  }
}

// Singleton instance
export const executor = new TestExecutor();
