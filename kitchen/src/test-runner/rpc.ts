import type { RPCSchema } from "electrobun";
import type { TestResult } from "../test-framework/types";
import type { UpdateStatusType, UpdateStatusEntry, UpdateStatusDetails } from "electrobun/main";

export interface TestInfo {
  id: string;
  name: string;
  category: string;
  description?: string;
  instructions?: string[];
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

export interface TestRunnerPreferences {
  searchQuery: string;
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
      getTestRunnerPreferences: {
        params: {};
        response: TestRunnerPreferences;
      };
      setTestRunnerPreferences: {
        params: TestRunnerPreferences;
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
      buildConfig: {
        defaultRenderer: 'native' | 'cef';
        availableRenderers: ('native' | 'cef')[];
        mainProcess?: 'bun' | 'cottontail' | 'zig' | 'rust' | 'go' | 'odin';
        cefVersion?: string;
        bunVersion?: string;
        zigVersion?: string;
        rustVersion?: string;
        goVersion?: string;
      };
      updateStatus: UpdateInfo;
      updateStatusEntry: UpdateStatusEntry;
    };
  }>;
};
