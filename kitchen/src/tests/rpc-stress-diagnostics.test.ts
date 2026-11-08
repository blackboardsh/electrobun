import { describe, expect, test } from "bun:test";
import { reportRpcStressFailure } from "./rpc-stress-diagnostics";

describe("RPC burst failure reporting", () => {
  const timeoutSummary = {
    expectedRequests: 1000,
    hostEchoRequests: 1000,
    hostQueue: { queuedMessages: 0, queuedBytes: 0 },
    requestSummary: { received: 1000, errorCount: 1000 },
    outboundMessages: { count: 5000, expectedCount: 5000, missingCount: 0 },
  };

  async function replay(
    errorCount: number,
    snapshot: () => unknown,
    log: (message: string) => void,
  ) {
    const failure = new Error(`Expected 0, got ${errorCount}`);
    try {
      if (errorCount !== 0) throw failure;
      return "passed";
    } catch (error) {
      reportRpcStressFailure(snapshot, log);
      expect(error).toBe(failure);
      throw error;
    }
  }

  test("preserves the failed request assertion while reporting delivery stages", async () => {
    const lines: string[] = [];
    await expect(replay(1000, () => timeoutSummary, line => lines.push(line))).rejects.toThrow("Expected 0, got 1000");
    expect(lines).toHaveLength(1);
    const report = JSON.parse(lines[0]!.slice("RPC burst failure diagnostics: ".length));
    expect(report).toEqual(timeoutSummary);
  });

  test("does not collect diagnostics or alter a successful burst", async () => {
    let reads = 0;
    const lines: string[] = [];
    expect(await replay(0, () => { reads += 1; }, line => lines.push(line))).toBe("passed");
    expect(reads).toBe(0);
    expect(lines).toEqual([]);
  });

  test("snapshot and logger errors cannot replace the failing assertion", async () => {
    const lines: string[] = [];
    await expect(replay(1000, () => { throw new Error("snapshot unavailable"); }, line => lines.push(line))).rejects.toThrow("Expected 0, got 1000");
    expect(lines[0]).toContain("snapshot unavailable");
    await expect(replay(1000, () => timeoutSummary, () => {
      throw new Error("logger unavailable");
    })).rejects.toThrow("Expected 0, got 1000");
  });

  test("bounds unexpected diagnostic output", () => {
    const lines: string[] = [];
    reportRpcStressFailure(() => ({ payload: "x".repeat(100000) }), line => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThanOrEqual(4031);
  });
});
