import { describe, expect, test } from "bun:test";
import {
  assertHeldWebview2State, assertReadyWebview2State,
  parseWebview2InitializationState, physicalRect,
  type Webview2InitializationState,
} from "./webview2-initialization-state";

const rect = { x: 82, y: 98, width: 362, height: 258 };
const masks = '[{"x":11,"y":13,"width":17,"height":19}]';
const held: Webview2InitializationState = {
  held: true, ready: false, controllerPresent: false, visible: null, desiredTransparent: false,
  passthrough: false, desiredPassthrough: false, bounds: null, requestedBounds: rect,
  maskJSON: masks, resizeRequests: 4, dpi: 192,
};
const ready = { ...held, held: false, ready: true, controllerPresent: true, visible: true, bounds: rect };

describe("WebView2 pre-controller native assertion contract", () => {
  test("requires genuine held native updates and actual ready controller state", () => {
    assertHeldWebview2State(parseWebview2InitializationState(JSON.stringify(held)), rect, masks);
    assertReadyWebview2State(parseWebview2InitializationState(JSON.stringify(ready)), held, rect);
  });
  test("rejects stale requested bounds while held", () => {
    expect(() => assertHeldWebview2State({ ...held, requestedBounds: { ...rect, width: 0 } }, rect, masks)).toThrow("bounds lost");
  });
  test("rejects a warm controller that was never held", () => {
    expect(() => assertHeldWebview2State(ready, rect, masks)).toThrow("not held");
  });
  test("rejects masks dropped before controller creation", () => {
    expect(() => assertHeldWebview2State({ ...held, maskJSON: "" }, rect, masks)).toThrow("mask state lost");
  });
  test("rejects a post-release resize rescue even when pixels now match", () => {
    expect(() => assertReadyWebview2State({ ...ready, resizeRequests: 5 }, held, rect)).toThrow("post-release resize");
  });
  test("rejects native stale size or a deferred initial hide overriding reveal", () => {
    expect(() => assertReadyWebview2State({ ...ready, bounds: { ...rect, width: 0 } }, held, rect)).toThrow("bounds are stale");
    expect(() => assertReadyWebview2State({ ...ready, visible: false }, held, rect)).toThrow("latest reveal");
    expect(() => assertReadyWebview2State({ ...ready, desiredTransparent: true }, held, rect)).toThrow("latest reveal");
  });
  test("rejects malformed or insufficient diagnostic snapshots", () => {
    expect(() => parseWebview2InitializationState("{}")).toThrow();
    expect(() => parseWebview2InitializationState(JSON.stringify({ ...held, resizeRequests: undefined }))).toThrow("counter");
    expect(() => parseWebview2InitializationState(JSON.stringify({ ...ready, bounds: { x: 0 } }))).toThrow("bounds");
  });
  test("converts DIP edges once at fractional Windows scale", () => {
    expect(physicalRect({ x: 41, y: 49, width: 181, height: 129 }, 2)).toEqual(rect);
    expect(physicalRect({ x: 1, y: 1, width: 1, height: 1 }, 1.5)).toEqual({ x: 2, y: 2, width: 1, height: 1 });
  });
  test("native definition parses and is registered for automated Kitchen runs", async () => {
    const source = await Bun.file(new URL("./webview2-initialization.test.ts", import.meta.url)).text();
    const index = await Bun.file(new URL("./index.ts", import.meta.url)).text();
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(source)).not.toThrow();
    expect(index).toContain('import { webview2InitializationTests } from "./webview2-initialization.test"');
    expect(index).toContain("...webview2InitializationTests,");
    expect(source).not.toContain("interactive: true");
    expect(source).toContain('requires: { platform: "win32" }');
  });
});
