import { dirname, join } from "node:path";
import { defineTest, expect } from "../test-framework/types";
import { createTestHarnessRPC } from "./rpc.test";
import {
  assertHeldWebview2State, assertReadyWebview2State,
  parseWebview2InitializationState, physicalRect,
  type Webview2InitializationState,
} from "./webview2-initialization-state";

const selector = '[data-kitchen-webview2-initialization="child"]';
const finalFrame = { x: 41, y: 49, width: 181, height: 129 };
const finalMasks = JSON.stringify([{ x: 11, y: 13, width: 17, height: 19 }]);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const webview2InitializationTests = [
  defineTest({
    name: "WebView2 applies pre-controller bounds and reveal",
    category: "WebView2 Initialization",
    description: "Hold real native child creation; verify latest queued bounds, masks and reveal without a resize rescue",
    requires: { platform: "win32" },
    timeout: 60000,
    async run({ createWindow, log }) {
      // Internal diagnostics only: do not add these gated test exports to the
      // supported SDK ABI or load a separately-selected DLL into this process.
      const { dlopen, FFIType, ptr } = await import("bun:ffi");
      const symbols = {
        webview2TestHoldNextController: { args: [], returns: FFIType.bool },
        webview2TestReleaseController: { args: [FFIType.u32], returns: FFIType.bool },
        webview2TestGetState: { args: [FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
      } as const;
      let library: ReturnType<typeof dlopen<typeof symbols>> | undefined;
      let loadError: unknown;
      // Same packaged locations as the SDK. No PATH or environment overrides.
      for (const path of new Set([join(dirname(process.execPath), "libNativeWrapper.dll"), join(process.cwd(), "libNativeWrapper.dll")])) {
        try {
          library = dlopen(path, symbols);
          break;
        } catch (error) { loadError = error; }
      }
      if (!library) throw new Error(`Bundled WebView2 test diagnostics unavailable: ${String(loadError)}`);
      const native = library.symbols;
      const deadline = Date.now() + 45000;
      let win: Awaited<ReturnType<typeof createWindow>> | undefined;
      let holdArmed = false;
      let primaryError: unknown;
      let lastHeldSnapshot: Webview2InitializationState | null = null;

      const readState = (id: number): Webview2InitializationState | null => {
        const bytes = new Uint8Array(16384);
        if (!native.webview2TestGetState(id, ptr(bytes), bytes.byteLength)) return null;
        const end = bytes.indexOf(0);
        if (end < 0) throw new Error("Native WebView2 diagnostic output was not terminated");
        return parseWebview2InitializationState(new TextDecoder().decode(bytes.subarray(0, end)));
      };
      const waitFor = async <T>(label: string, read: () => T | null | Promise<T | null>, budget = 10000): Promise<T> => {
        const until = Math.min(deadline, Date.now() + budget);
        while (Date.now() < until) {
          const value = await read();
          if (value !== null) return value;
          await sleep(50);
        }
        throw new Error(`Timed out waiting for ${label}`);
      };
      const evaluate = (script: string, maxRequestTime = 3000) =>
        win!.webview.rpc.request.evaluateJavascriptWithResponse({ script }, { maxRequestTime });

      try {
        win = await createWindow({
          title: "WebView2 pre-controller update regression",
          renderer: "native", width: 640, height: 480,
          url: "views://test-harness/index.html", rpc: createTestHarnessRPC(),
        });
        // This polling is read-only. It must finish before arming the one-shot
        // hold, so the host controller cannot accidentally consume the latch.
        await waitFor("native host preload", async () => {
          try {
            return await evaluate("return Boolean(customElements.get('electrobun-webview'));", 500) ? true : null;
          } catch { return null; }
        }, 15000);
        holdArmed = native.webview2TestHoldNextController();
        if (!holdArmed) throw new Error("WebView2 test gate disabled or already armed; run a dev Kitchen build or launch with ELECTROBUN_KITCHEN_WEBVIEW2_TEST=1");

        // One actual tag, initially zero-sized and hidden like an inactive Dash
        // slate. Never recreate it if a mutating RPC times out.
        await evaluate(`
          const mask = document.createElement('div');
          mask.className = 'kitchen-webview2-initialization-mask';
          mask.style.cssText = 'position:fixed;left:14px;top:18px;width:7px;height:9px;pointer-events:none';
          document.body.appendChild(mask);
          const child = document.createElement('electrobun-webview');
          child.dataset.kitchenWebview2Initialization = 'child';
          child.setAttribute('renderer', 'native');
          child.setAttribute('transparent', '');
          child.setAttribute('passthrough', '');
          child.setAttribute('masks', '.kitchen-webview2-initialization-mask');
          child.setAttribute('src', 'views://test-harness/index.html');
          child.style.cssText = 'position:fixed;display:block;left:0;top:0;width:0;height:0';
          document.body.appendChild(child);
          return true;
        `);
        const childId = await waitFor<number>("held child ID", async () => {
          const id: unknown = await evaluate(`return document.querySelector(${JSON.stringify(selector)})?.webviewId ?? null;`);
          return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
        });
        const initial = readState(childId);
        expect(initial?.held, "native creation hold consumed by exact child").toBe(true);
        expect(initial?.ready, "controller absent before updates").toBe(false);

        // Distinct frame/mask/reveal generations: the final values must win.
        // Only normal element APIs are used; no diagnostic setter can fix it.
        await evaluate(`
          const child = document.querySelector(${JSON.stringify(selector)});
          child.style.cssText = 'position:fixed;display:block;left:3px;top:5px;width:91px;height:73px';
          child.syncDimensions(true);
          child.toggleTransparent(false); child.togglePassthrough(false);
          child.toggleTransparent(true); child.togglePassthrough(true);
          const mask = document.querySelector('.kitchen-webview2-initialization-mask');
          mask.style.cssText = 'position:fixed;left:52px;top:62px;width:17px;height:19px;pointer-events:none';
          child.style.cssText = 'position:fixed;display:block;left:41px;top:49px;width:181px;height:129px';
          child.syncDimensions(true);
          child.toggleTransparent(false); child.togglePassthrough(false);
          return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve(true), 200))));
        `);
        const held = await waitFor("latest pre-controller state", () => {
          const state = readState(childId);
          if (!state) return null;
          lastHeldSnapshot = state;
          const expected = physicalRect(finalFrame, state.dpi / 96);
          // Native transport may still be draining; only an observed held
          // controller with the exact latest state permits release.
          if (state.ready || !state.held) throw new Error("Native hold ended before the test released it");
          try { assertHeldWebview2State(state, expected, finalMasks); return state; }
          catch { return null; }
        });
        const expected = physicalRect(finalFrame, held.dpi / 96);
        assertHeldWebview2State(held, expected, finalMasks);
        log(`Held native child ${childId}: ${JSON.stringify(held)}`);
        await waitFor("held native environment completion", () => native.webview2TestReleaseController(childId) ? true : null);
        holdArmed = false;
        const ready = await waitFor("real native controller", () => {
          const state = readState(childId);
          return state?.ready ? state : null;
        }, 15000);
        assertReadyWebview2State(ready, held, expected);
        // Observe again after normal event dispatch. A deferred initial hide
        // or a resize rescue must not make a transient snapshot look green.
        await sleep(250);
        const stable = readState(childId);
        if (!stable) throw new Error("Native child disappeared after becoming ready");
        assertReadyWebview2State(stable, held, expected);
        log(`Ready native child without post-release resize: ${JSON.stringify(stable)}`);
      } catch (error) {
        primaryError = error;
        if (lastHeldSnapshot) log(`Last held-phase snapshot: ${JSON.stringify(lastHeldSnapshot)}`);
        throw error;
      } finally {
        // release(0) disarms only an unused one-shot, never another live child.
        // Removing the owned tag cancels a consumed held creation. The executor
        // also closes this exact test window on every assertion failure.
        const cleanupErrors: unknown[] = [];
        try {
          if (holdArmed) native.webview2TestReleaseController(0);
        } catch (error) { cleanupErrors.push(error); }
        try {
          if (win) await evaluate(`document.querySelector(${JSON.stringify(selector)})?.remove(); return true;`, 1000);
        } catch (error) {
          cleanupErrors.push(error);
        } finally {
          try { library.close(); } catch (error) { cleanupErrors.push(error); }
        }
        if (cleanupErrors.length) {
          log(`Owned tag cleanup errors (executor will close its host window): ${cleanupErrors.map(String).join("; ")}`);
          if (primaryError === undefined) throw new AggregateError(cleanupErrors, "Failed to remove owned WebView2 fixture");
        }
      }
    },
  }),
];
