import { describe, expect, test } from "bun:test";
import { resolveWebviewTagPlaygroundCapabilities } from "./interactive/webview-tag-capabilities";

describe("webview tag playground capabilities", () => {
  test("uses CEF capabilities when CEF is bundled", () => {
    expect(
      resolveWebviewTagPlaygroundCapabilities("win32", ["native", "cef"]),
    ).toEqual({ renderer: "cef", masks: true, passthrough: true });
  });

  test("disables masks and passthrough for Windows WebView2", () => {
    expect(resolveWebviewTagPlaygroundCapabilities("win32", ["native"])).toEqual({
      renderer: "native",
      masks: false,
      passthrough: false,
    });
  });

  test("keeps native macOS masks and passthrough enabled", () => {
    expect(resolveWebviewTagPlaygroundCapabilities("darwin", ["native"])).toEqual({
      renderer: "native",
      masks: true,
      passthrough: true,
    });
  });

  test("keeps native Linux passthrough enabled but disables masks", () => {
    expect(resolveWebviewTagPlaygroundCapabilities("linux", ["native"])).toEqual({
      renderer: "native",
      masks: false,
      passthrough: true,
    });
  });
});
