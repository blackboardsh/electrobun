import { dirname, join } from "node:path";
import { defineTest, sleep } from "../test-framework/types";
import { createTestHarnessRPC } from "./rpc.test";
import { physicalRect } from "./webview2-initialization-state";
import {
  assertOwnedWebview2Children, assertPresentedWebview2Child, parseWebview2StackingState,
  type Pixel, type Webview2StackingState,
} from "./webview2-stacking-state";

const selector = "[data-kitchen-webview2-stacking]";
const frame = { x: 43, y: 57, width: 201, height: 151 };
const green: Pixel = { r: 19, g: 201, b: 87 };
const blue: Pixel = { r: 37, g: 83, b: 211 };
const yellow: Pixel = { r: 233, g: 181, b: 29 };

export const webview2StackingTest = defineTest({
  name: "WebView2 owns and presents restored overlapping children",
  category: "WebView2 Initialization",
  description: "Create hidden zero-size siblings, then reveal, overlap and replace them; assert controller HWND identity, host input style and actual desktop pixels",
  requires: { platform: "win32" },
  timeout: 90000,
  async run({ createWindow, log }) {
    const { dlopen, FFIType, ptr } = await import("bun:ffi");
    const symbols = {
      webview2TestGetState: { args: [FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
    } as const;
    let library: ReturnType<typeof dlopen<typeof symbols>> | undefined;
    let loadError: unknown;
    for (const path of new Set([join(dirname(process.execPath), "libNativeWrapper.dll"), join(process.cwd(), "libNativeWrapper.dll")])) {
      try { library = dlopen(path, symbols); break; }
      catch (error) { loadError = error; }
    }
    if (!library) throw new Error(`Bundled WebView2 test diagnostics unavailable: ${String(loadError)}`);
    const native = library.symbols;
    const deadline = Date.now() + 80000;
    let win: Awaited<ReturnType<typeof createWindow>> | undefined;
    let primaryError: unknown;
    let lastObservation: unknown;

    const readState = (id: number): Webview2StackingState | null => {
      const bytes = new Uint8Array(16384);
      if (!native.webview2TestGetState(id, ptr(bytes), bytes.byteLength)) return null;
      const end = bytes.indexOf(0);
      if (end < 0) throw new Error("Native WebView2 diagnostic output was not terminated");
      return parseWebview2StackingState(new TextDecoder().decode(bytes.subarray(0, end)));
    };
    const waitFor = async <T>(label: string, read: () => T | null | Promise<T | null>, budget = 10000): Promise<T> => {
      const until = Math.min(deadline, Date.now() + budget);
      while (Date.now() < until) {
        const value = await read();
        if (value !== null) return value;
        await sleep(40);
      }
      throw new Error(`Timed out waiting for ${label}; last observation: ${JSON.stringify(lastObservation)}`);
    };
    const evaluate = (script: string, maxRequestTime = 3000) =>
      win!.webview.rpc.request.evaluateJavascriptWithResponse({ script }, { maxRequestTime });
    const element = (name: string) => `document.querySelector('[data-kitchen-webview2-stacking="${name}"]')`;
    const createChild = async (name: string, color: Pixel) => {
      const html = `<html><head><style>html,body{margin:0;width:100%;height:100%;background:rgb(${color.r},${color.g},${color.b})}</style></head><body></body></html>`;
      // The zero-size controller must actually finish creation before any
      // resize. A queued pre-controller update would miss the reported bug.
      await evaluate(`
        const child = document.createElement('electrobun-webview');
        child.dataset.kitchenWebview2Stacking = ${JSON.stringify(name)};
        child.setAttribute('renderer', 'native');
        child.setAttribute('transparent', ''); child.setAttribute('passthrough', '');
        child.setAttribute('html', ${JSON.stringify(html)});
        child.style.cssText = 'position:fixed;display:block;left:0;top:0;width:0;height:0';
        document.body.appendChild(child); return true;
      `);
      const id = await waitFor<number>(`${name} ID`, async () => {
        const value = await evaluate(`return ${element(name)}?.webviewId ?? null;`);
        return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
      });
      await waitFor(`${name} hidden zero-size controller`, () => {
        const state = readState(id);
        lastObservation = state;
        if (!state?.ready) return null;
        if (state.bounds?.width !== 0 || state.bounds?.height !== 0 || state.visible !== false ||
            !state.desiredTransparent || !state.desiredPassthrough) {
          throw new Error(`Fixture did not create a hidden zero-size controller: ${JSON.stringify(state)}`);
        }
        return state;
      }, 15000);
      return id;
    };
    const reveal = (name: string) => evaluate(`
      const child = ${element(name)};
      child.style.cssText = 'position:fixed;display:block;left:${frame.x}px;top:${frame.y}px;width:${frame.width}px;height:${frame.height}px';
      child.syncDimensions(true); child.toggleTransparent(false); child.togglePassthrough(false);
      return true;
    `);

    try {
      win = await createWindow({
        title: "WebView2 restored sibling presentation regression",
        renderer: "native", width: 640, height: 480, activate: true,
        url: "views://test-harness/index.html", rpc: createTestHarnessRPC(),
      });
      // Kitchen's runner is itself always-on-top. Put this owned test window
      // above it so desktop pixels measure the guest, not the runner beneath
      // the same screen coordinates. This does not change child HWND stacking.
      win.window.setAlwaysOnTop(true);
      win.window.activate();
      await waitFor("host preload", async () => {
        try { return await evaluate("return Boolean(customElements.get('electrobun-webview'));", 500) ? true : null; }
        catch { return null; }
      }, 15000);
      await evaluate("document.body.replaceChildren(); document.body.style.cssText='margin:0;background:rgb(19,31,47)'; document.documentElement.style.background='rgb(19,31,47)'; return true;");
      const hostId = win.webviewId;
      const baseline = readState(hostId);
      if (!baseline?.ready || !baseline.childOwned || baseline.childExStyle === null) {
        throw new Error("Live native host ownership diagnostics unavailable; use a dev Kitchen build or ELECTROBUN_KITCHEN_WEBVIEW2_TEST=1");
      }
      const originalHostStyle = baseline.childExStyle;
      const host = () => {
        const state = readState(hostId);
        if (!state) throw new Error("Host native controller disappeared");
        if (state.childHwnd !== baseline.childHwnd || state.childExStyle !== originalHostStyle) {
          throw new Error(`Guest creation/reveal changed host HWND or input style: ${JSON.stringify(state)}`);
        }
        return state;
      };
      const presented = (id: number, color: Pixel) => waitFor("owned visible guest pixels", () => {
        const parent = host();
        const child = readState(id);
        lastObservation = { host: parent, child };
        if (!child) return null;
        try {
          assertPresentedWebview2Child(child, parent, physicalRect(frame, child.dpi / 96), color, originalHostStyle);
          return child;
        } catch { return null; }
      });

      const first = await createChild("first", green);
      const second = await createChild("second", blue);
      assertOwnedWebview2Children([host(), readState(first)!, readState(second)!]);
      log(`Hidden zero-size siblings: ${JSON.stringify({ host: host(), first: readState(first), second: readState(second) })}`);
      await reveal("first");
      log(`First presented: ${JSON.stringify(await presented(first, green))}`);

      // Identical rectangles deliberately make position/size lookup ambiguous.
      await reveal("second");
      const secondVisible = await presented(second, blue);
      assertOwnedWebview2Children([host(), readState(first)!, secondVisible]);
      if (secondVisible.childSiblingIndex! >= readState(first)!.childSiblingIndex!) {
        throw new Error("Newer overlapping child is behind its older sibling");
      }
      await evaluate(`const child = ${element("second")}; child.toggleTransparent(true); child.togglePassthrough(true); return true;`);
      await presented(first, green);
      await evaluate(`${element("second")}.remove(); return true;`);
      await waitFor("removed sibling registry entry", () => readState(second) === null ? true : null);

      const replacement = await createChild("replacement", yellow);
      if (replacement === second) throw new Error("Removed controller ID was reused");
      if (readState(second) !== null) throw new Error("Removed view regained a native registry entry");
      assertOwnedWebview2Children([host(), readState(first)!, readState(replacement)!]);
      // A hidden replacement must neither obscure nor make the live sibling
      // transparent. HWND numbers may be recycled; verified ownership may not.
      await presented(first, green);
      await reveal("replacement");
      await presented(replacement, yellow);
      await evaluate(`${element("first")}.remove(); return true;`);
      await waitFor("first sibling removal", () => readState(first) === null ? true : null);
      log(`Replacement survives sibling destruction: ${JSON.stringify(await presented(replacement, yellow))}`);
    } catch (error) {
      primaryError = error;
      if (lastObservation) log(`Last native presentation snapshot: ${JSON.stringify(lastObservation)}`);
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        if (win) await evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).forEach(child => child.remove()); return true;`, 1000);
      } catch (error) { cleanupErrors.push(error); }
      try { library.close(); } catch (error) { cleanupErrors.push(error); }
      if (cleanupErrors.length) {
        log(`Owned presentation fixture cleanup errors (executor will close its host window): ${cleanupErrors.map(String).join("; ")}`);
        if (primaryError === undefined) throw new AggregateError(cleanupErrors, "Failed to remove owned presentation fixture");
      }
    }
  },
});
