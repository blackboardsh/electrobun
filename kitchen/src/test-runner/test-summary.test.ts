import { describe, expect, test } from "bun:test";
import { summarizeTestResults } from "./test-summary";

describe("Kitchen test summary", () => {
  test("counts skipped tests separately from pending tests", () => {
    expect(
      summarizeTestResults(5, [
        { status: "passed" },
        { status: "failed" },
        { status: "skipped" },
      ]),
    ).toEqual({
      total: 5,
      passed: 1,
      failed: 1,
      skipped: 1,
      pending: 2,
    });
  });
});
