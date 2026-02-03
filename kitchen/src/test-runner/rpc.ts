import type { RPCSchema } from "electrobun";
import type { TestResult } from "../test-framework/types";
import type { UpdateStatusType, UpdateStatusEntry, UpdateStatusDetails } from "electrobun/bun";

export interface TestInfo {
  id: string;
  name: string;
  category: string;
  description?: string;
  interactive: boolean;
}

export type UpdateStatus =
  | 'checking'
  | 'update-available'
  | 'downloading'
  | 'update-ready'
  | 'no-update'
  | 'error';

export type { UpdateStatusType, UpdateStatusEntry, UpdateStatusDetails };

export interface UpdateInfo {
  status: UpdateStatus;
  currentVersion: string;
  newVersion?: string;
  error?: string;
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
      applyUpdate: {
        params: {};
        response: void;
      };
      getUpdateStatusHistory: {
        params: {};
        response: UpdateStatusEntry[];
      };
      clearUpdateStatusHistory: {
        params: {};
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
        cefVersion?: string;
        bunVersion?: string;
      };
      updateStatus: UpdateInfo;
      updateStatusEntry: UpdateStatusEntry;
    };
  }>;
};
