import type { TestResult } from "../test-framework/types";

export type TestSummary = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  pending: number;
};

export function summarizeTestResults(
  total: number,
  results: Iterable<Pick<TestResult, "status">>,
): TestSummary {
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const result of results) {
    if (result.status === "passed") passed += 1;
    if (result.status === "failed") failed += 1;
    if (result.status === "skipped") skipped += 1;
  }

  return {
    total,
    passed,
    failed,
    skipped,
    pending: Math.max(0, total - passed - failed - skipped),
  };
}
