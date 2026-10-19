import { describe, expect, test } from "bun:test";
import {
  assertOwnedWebview2Children, assertPresentedWebview2Child, parseWebview2StackingState,
  type Webview2StackingState,
} from "./webview2-stacking-state";

const frame = { x: 43, y: 57, width: 201, height: 151 };
const green = { r: 19, g: 201, b: 87 };
const child: Webview2StackingState = {
  held: false, ready: true, controllerPresent: true, visible: true, desiredTransparent: false,
  passthrough: false, desiredPassthrough: false, bounds: frame, requestedBounds: frame,
  maskJSON: "", resizeRequests: 2, dpi: 96,
  childHwnd: "0x1234", childParentHwnd: "0x1000", childOwned: true, childVisible: true,
  childExStyle: 0, childSiblingIndex: 0, screenPixel: green,
};
const host = { ...child, childHwnd: "0x5678", childSiblingIndex: 1 };
const verify = (next: Webview2StackingState, parent = host) =>
  assertPresentedWebview2Child(next, parent, frame, green, 0);

describe("WebView2 owned-window presentation assertions", () => {
  test("accepts distinct controllers and observed visible guest pixels", () => {
    verify(parseWebview2StackingState(JSON.stringify(child)));
    assertOwnedWebview2Children([host, child]);
  });
  test("rejects an unowned or aliased controller HWND", () => {
    expect(() => verify({ ...child, childOwned: false })).toThrow("not owned");
    expect(() => verify({ ...child, childHwnd: host.childHwnd })).toThrow("same HWND");
    expect(() => verify({ ...child, childParentHwnd: "0x9999" })).toThrow("wrong parent");
    expect(() => verify({ ...child, removed: true })).toThrow("not live");
  });
  test("rejects the real failure even when navigation, bounds and controller visibility pass", () => {
    expect(() => verify({ ...child, childSiblingIndex: 2 })).toThrow("behind host");
    expect(() => verify({ ...child, screenPixel: { r: 255, g: 255, b: 255 } })).toThrow("pixel does not match");
    expect(() => verify({ ...child, screenPixel: null })).toThrow("pixel does not match");
  });
  test("rejects stale bounds, hidden HWNDs and passthrough applied to the wrong view", () => {
    expect(() => verify({ ...child, bounds: { ...frame, width: 0 } })).toThrow("bounds are stale");
    expect(() => verify({ ...child, childVisible: false })).toThrow("hidden");
    expect(() => verify({ ...child, childExStyle: 0x20 })).toThrow("input remains transparent");
    expect(() => verify(child, { ...host, childExStyle: 0x20 })).toThrow("host input style");
  });
  test("rejects incomplete native diagnostics instead of skipping pixel coverage", () => {
    expect(() => parseWebview2StackingState(JSON.stringify({ ...child, childOwned: undefined }))).toThrow("ownership proof");
    expect(() => parseWebview2StackingState(JSON.stringify({ ...child, screenPixel: undefined }))).toThrow("desktop pixel");
    expect(() => parseWebview2StackingState(JSON.stringify({ ...child, childSiblingIndex: -1 }))).toThrow("childSiblingIndex");
  });
  test("native fixture parses and stays registered with the automated initialization tests", async () => {
    const source = await Bun.file(new URL("./webview2-stacking.test.ts", import.meta.url)).text();
    const initialization = await Bun.file(new URL("./webview2-initialization.test.ts", import.meta.url)).text();
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(source)).not.toThrow();
    expect(initialization).toContain("webview2StackingTest,");
    expect(source).not.toContain("interactive: true");
    expect(source).toContain('requires: { platform: "win32" }');
  });
});
