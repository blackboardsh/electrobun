import { afterEach, expect, spyOn, test } from "bun:test";
import { finishWindowPhase, startWindowPhase } from "./window-diagnostics";

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
