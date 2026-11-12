import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { groupAutomatedTestsForRun, groupTestsForDisplay } from "./test-order.ts";

describe("complete automated suite order", () => {
  it("runs marked fixtures first without pulling their remaining category ahead or changing registration", () => {
    const tests = [
      { id: "view", category: "BrowserView", interactive: false },
      { id: "rpc", category: "RPC", interactive: false },
      { id: "window", category: "BrowserWindow", interactive: false },
      { id: "fullscreen", category: "BrowserWindow", interactive: false, automatedFirst: true },
      { id: "hidden-fullscreen", category: "BrowserWindow", interactive: false, automatedFirst: true },
      { id: "manual", category: "BrowserWindow", interactive: true, automatedFirst: true },
      { id: "view-again", category: "BrowserView", interactive: false },
    ];
    const original = [...tests];
    const groups = groupAutomatedTestsForRun(tests);
    assert.deepEqual(groups.map((group) => group.tests.map((test) => test.id)), [
      ["fullscreen", "hidden-fullscreen"], ["view", "view-again"], ["rpc"], ["window"],
    ]);
    assert.deepEqual(tests, original);
    assert.equal(new Set(groups.flatMap((group) => group.tests)).size, 6);
    assert.deepEqual(groupTestsForDisplay(tests).find((group) => !group.interactive && group.category === "BrowserWindow")?.tests.map((test) => test.id), [
      "window", "fullscreen", "hidden-fullscreen",
    ]);
  });

  it("marks exactly the normal and hidden fullscreen definitions for the early group", () => {
    const source = readFileSync(new URL("../tests/window.test.ts", import.meta.url), "utf8");
    const headers = [...source.matchAll(/defineTest\(\{([\s\S]*?)async run\(/g)].map((match) => match[1]!);
    const first = headers.filter((header) => /automatedFirst:\s*true/.test(header));
    assert.deepEqual(first.map((header) => header.match(/name:\s*"([^"]+)"/)?.[1]), [
      "Window fullscreen toggle", "Window fullscreen toggle with hidden titlebar",
    ]);
    for (const header of first) assert.match(header, /timeout:\s*15000/);
  });
});

describe("test runner display order", () => {
  it("puts every interactive test before automated tests and splits mixed categories", () => {
    const groups = groupTestsForDisplay([
      { id: "auto-a", category: "Shared", interactive: false },
      { id: "interactive-b", category: "Other", interactive: true },
      { id: "interactive-a", category: "Shared", interactive: true },
      { id: "auto-b", category: "Other", interactive: false },
    ]);

    assert.deepEqual(groups.map((group) => group.tests.map((test) => test.id)), [
      ["interactive-b"],
      ["interactive-a"],
      ["auto-a"],
      ["auto-b"],
    ]);
  });
});
