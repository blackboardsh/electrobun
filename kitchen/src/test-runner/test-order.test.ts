import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupTestsForDisplay } from "./test-order.ts";

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
