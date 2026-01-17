import type { RPCSchema } from "electrobun";
import type { TestDefinition, TestResult, TestStatus } from "../test-framework/types";

export interface TestInfo {
  id: string;
  name: string;
  category: string;
  description?: string;
  interactive: boolean;
}

export type TestRunnerRPC = {
  bun: RPCSchema<{
    requests: {
      getTests: {
        params: {};
        response: TestInfo[];
      };
      runTest: {
        params: { testId: string };
        response: TestResult;
      };
      runAllAutomated: {
        params: {};
        response: TestResult[];
      };
      runInteractiveTests: {
        params: {};
        response: TestResult[];
      };
      submitInteractiveResult: {
        params: { testId: string; passed: boolean; notes?: string };
        response: void;
      };
      submitReady: {
        params: { testId: string };
        response: void;
      };
      submitVerification: {
        params: { testId: string; action: 'pass' | 'fail' | 'retest'; notes?: string };
        response: void;
      };
    };
    messages: {
      logToBun: {
        msg: string;
      };
    };
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      testStarted: {
        testId: string;
        name: string;
      };
      testCompleted: {
        testId: string;
        result: TestResult;
      };
      testLog: {
        testId: string;
        message: string;
      };
      allCompleted: {
        results: TestResult[];
      };
      interactiveWaiting: {
        testId: string;
        instructions: string[];
      };
      interactiveReady: {
        testId: string;
        instructions: string[];
      };
      interactiveVerify: {
        testId: string;
      };
      buildConfig: {
        defaultRenderer: 'native' | 'cef';
        availableRenderers: ('native' | 'cef')[];
      };
    };
  }>;
};
