import { describe, expect, test } from "bun:test";
import { getTestSkipReason } from "./requirements";
import { defineTest } from "./types";

const noOpRun = async () => {};

describe("Kitchen test renderer requirements", () => {
  test("runs a CEF-specific test when CEF is bundled", () => {
    const cefTest = defineTest({
      name: "CEF-specific",
      category: "contract",
      requires: { renderer: "cef" },
      run: noOpRun,
    });

    expect(getTestSkipReason(cefTest, ["native", "cef"])).toBeUndefined();
  });

  test("skips a CEF-specific test when only the system renderer is bundled", () => {
    const cefTest = defineTest({
      name: "CEF-specific",
      category: "contract",
      requires: { renderer: "cef" },
      run: noOpRun,
    });

    expect(getTestSkipReason(cefTest, ["native"])).toContain(
      "requires the CEF renderer",
    );
  });

  test("never turns a CEF request into a hard requirement", () => {
    const fallbackTest = defineTest({
      name: "CEF fallback",
      category: "contract",
      async run({ createWindow }) {
        // Critical contract: this requests CEF and must still run in a
        // system-only build so BrowserWindow's fallback is exercised.
        await createWindow({ renderer: "cef" });
      },
    });

    expect(getTestSkipReason(fallbackTest, ["native"])).toBeUndefined();
  });
});

describe("Kitchen native platform requirements", () => {
  const windowsTest = defineTest({
    name: "WebView2 initialization",
    category: "contract",
    requires: { platform: "win32" },
    run: noOpRun,
  });

  test("reports Windows native coverage skipped on Linux and macOS", () => {
    expect(getTestSkipReason(windowsTest, ["native"], "linux")).toBe("requires win32, running on linux");
    expect(getTestSkipReason(windowsTest, ["native", "cef"], "darwin")).toBe("requires win32, running on darwin");
  });

  test("runs the platform test on Windows without requiring CEF", () => {
    expect(getTestSkipReason(windowsTest, ["native"], "win32")).toBeUndefined();
  });

  test("retains independent renderer requirements on the matching platform", () => {
    const both = { ...windowsTest, requires: { platform: "win32" as const, renderer: "cef" as const } };
    expect(getTestSkipReason(both, ["native"], "win32")).toContain("requires the CEF renderer");
    expect(getTestSkipReason(both, ["native", "cef"], "win32")).toBeUndefined();
  });
});
