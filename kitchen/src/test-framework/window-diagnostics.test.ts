import { afterEach, expect, spyOn, test } from "bun:test";
import { finishWindowPhase, readWindowSnapshot, startWindowPhase } from "./window-diagnostics";

const originalFlag = process.env["ELECTROBUN_DEBUG_FULLSCREEN"];
const restorers: (() => void)[] = [];
afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  if (originalFlag === undefined) delete process.env["ELECTROBUN_DEBUG_FULLSCREEN"];
  else process.env["ELECTROBUN_DEBUG_FULLSCREEN"] = originalFlag;
});

test("disabled diagnostics do not read the clock or emit output", () => {
  delete process.env["ELECTROBUN_DEBUG_FULLSCREEN"];
  const clock = spyOn(performance, "now");
  const output = spyOn(console, "error").mockImplementation(() => {});
  restorers.push(() => clock.mockRestore(), () => output.mockRestore());
  const phase = startWindowPhase("fixture.construct", undefined, "fullscreen-test");
  finishWindowPhase(phase, 29);
  expect(phase).toBeUndefined();
  expect(clock).not.toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
});

test("enabled diagnostics correlate phase durations and newly created window IDs", () => {
  process.env["ELECTROBUN_DEBUG_FULLSCREEN"] = "1";
  const clock = spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(9234);
  const output = spyOn(console, "error").mockImplementation(() => {});
  restorers.push(() => clock.mockRestore(), () => output.mockRestore());
  const phase = startWindowPhase("fixture.construct", undefined, "fullscreen-test");
  finishWindowPhase(phase, 29);
  const entries = output.mock.calls.map(([line]) => JSON.parse(String(line).replace("[kitchen window phase] ", "")));
  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatchObject({ phase: "start", operation: "fixture.construct", testId: "fullscreen-test", tMs: 100 });
  expect(entries[1]).toMatchObject({ phase: "end", operation: "fixture.construct", testId: "fullscreen-test", windowId: 29, tMs: 9234, elapsedMs: 9134 });
  expect(entries[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  expect(entries[1].at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  expect(clock).toHaveBeenCalledTimes(2);
});

test("disabled snapshot diagnostics preserve reads without clocks or output", () => {
  delete process.env["ELECTROBUN_DEBUG_FULLSCREEN"];
  const clock = spyOn(performance, "now");
  const output = spyOn(console, "error").mockImplementation(() => {});
  restorers.push(() => clock.mockRestore(), () => output.mockRestore());
  const calls: string[] = [];
  const frame = { x: 100, y: 100, width: 800, height: 600 };
  const workArea = { x: 0, y: 31, width: 1024, height: 677 };
  const snapshot = readWindowSnapshot({
    isFullScreen: () => { calls.push("isFullScreen"); return true; },
    getFrame: () => { calls.push("getFrame"); return frame; },
    getPrimaryDisplay: () => { calls.push("getPrimaryDisplay"); return workArea; },
  }, 29);
  expect(calls).toEqual(["isFullScreen", "getFrame", "getPrimaryDisplay"]);
  expect(snapshot.fullscreen).toBe(true);
  expect(snapshot.frame).toBe(frame);
  expect(snapshot.workArea).toBe(workArea);
  expect(clock).not.toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
});

test.each([0, 100])("snapshot diagnostics stay silent at %dms", (duration) => {
  process.env["ELECTROBUN_DEBUG_FULLSCREEN"] = "1";
  let now = 500;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const output = spyOn(console, "error").mockImplementation(() => {});
  restorers.push(() => clock.mockRestore(), () => output.mockRestore());
  readWindowSnapshot({
    isFullScreen: () => false,
    getFrame: () => { now += duration; return {}; },
    getPrimaryDisplay: () => ({}),
  }, 29);
  expect(output).not.toHaveBeenCalled();
});

test("slow snapshots attribute existing reads and preserve their order and results", () => {
  process.env["ELECTROBUN_DEBUG_FULLSCREEN"] = "1";
  let now = 1000;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const output = spyOn(console, "error").mockImplementation(() => {});
  restorers.push(() => clock.mockRestore(), () => output.mockRestore());
  const calls: string[] = [];
  const frame = { x: 100, y: 100, width: 800, height: 600 };
  const workArea = { x: 0, y: 31, width: 1024, height: 677 };
  const snapshot = readWindowSnapshot({
    isFullScreen: () => { calls.push("isFullScreen"); now += 5; return true; },
    getFrame: () => { calls.push("getFrame"); now += 120; return frame; },
    getPrimaryDisplay: () => { calls.push("getPrimaryDisplay"); now += 25; return workArea; },
  }, 29);
  expect(calls).toEqual(["isFullScreen", "getFrame", "getPrimaryDisplay"]);
  expect(snapshot.fullscreen).toBe(true);
  expect(snapshot.frame).toBe(frame);
  expect(snapshot.workArea).toBe(workArea);
  expect(output).toHaveBeenCalledTimes(1);
  const entry = JSON.parse(String(output.mock.calls[0]?.[0]).replace("[kitchen window phase] ", ""));
  expect(entry).toMatchObject({
    phase: "slow-snapshot", operation: "fullscreen.restorationSnapshot", windowId: 29,
    startedTMs: 1000, tMs: 1150, elapsedMs: 150,
    fieldElapsedMs: { isFullScreen: 5, getFrame: 120, getPrimaryDisplay: 25 },
  });
  expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
});

test.each([undefined, "1"])("snapshot read errors propagate unchanged with flag %s", (flag) => {
  if (flag === undefined) delete process.env["ELECTROBUN_DEBUG_FULLSCREEN"];
  else process.env["ELECTROBUN_DEBUG_FULLSCREEN"] = flag;
  const failure = new Error("window closed");
  const calls: string[] = [];
  expect(() => readWindowSnapshot({
    isFullScreen: () => { calls.push("isFullScreen"); return false; },
    getFrame: () => { calls.push("getFrame"); throw failure; },
    getPrimaryDisplay: () => { calls.push("getPrimaryDisplay"); return {}; },
  }, 29)).toThrow(failure);
  expect(calls).toEqual(["isFullScreen", "getFrame"]);
});
