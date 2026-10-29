import { describe, expect, test } from "bun:test";
import { waitForWindowObservation } from "./window-observation";

function fakeClock(timeoutMs = 1000) {
  let elapsed = 0;
  return {
    timeoutMs,
    now: () => elapsed,
    sleep: async (ms: number) => { elapsed += ms; },
  };
}

const target = (size: { width: number; height: number }) =>
  Math.abs(size.width - 600) < 50 && Math.abs(size.height - 500) < 50;

describe("window resize observation", () => {
  test("waits through the original frame and intermediate animation frames", async () => {
    const clock = fakeClock();
    const logs: string[] = [];
    const size = await waitForWindowObservation("grow to 600x500", () => {
      if (clock.now() < 175) return { width: 420, height: 308 };
      if (clock.now() < 250) return { width: 600, height: 400 };
      return { width: 600, height: 500 };
    }, target, { ...clock, log: (line) => logs.push(line) });
    expect(size).toEqual({ width: 600, height: 500 });
    expect(clock.now()).toBe(250);
    expect(logs[0]).toContain('first={"width":420,"height":308}');
    expect(logs[0]).toContain("250ms");
  });

  test("fails at the deadline when the resize never takes effect", async () => {
    const clock = fakeClock(60);
    await expect(waitForWindowObservation("grow to 600x500", () => ({ width: 420, height: 308 }), target, clock))
      .rejects.toThrow('grow to 600x500 timed out after 60ms (limit 60ms): first={"width":420,"height":308}, last={"width":420,"height":308}');
    expect(clock.now()).toBe(60);
  });

  test("keeps the existing strict tolerance", async () => {
    const clock = fakeClock(60);
    await expect(waitForWindowObservation("grow", () => ({ width: 550, height: 500 }), target, clock))
      .rejects.toThrow("timed out");
  });

  test("propagates a failed native or viewport read immediately", async () => {
    const clock = fakeClock();
    const failure = new Error("window closed");
    let reads = 0;
    await expect(waitForWindowObservation("grow", () => { reads++; throw failure; }, target, clock))
      .rejects.toThrow("window closed");
    expect(reads).toBe(1);
    expect(clock.now()).toBe(0);
  });

  test("rejects a matching frame returned after the deadline", async () => {
    const clock = fakeClock(60);
    await expect(waitForWindowObservation("grow", async () => {
      await clock.sleep(61);
      return { width: 600, height: 500 };
    }, target, clock)).rejects.toThrow("timed out after 61ms");
  });
});
