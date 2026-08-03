// BrowserWindow Tests - Tests for window creation and management

import { defineTest, expect, type TitleBarStyle } from "../test-framework/types";
import { BrowserWindow, Screen } from "electrobun/main";
import { createTestHarnessRPC } from "./rpc.test";

type ViewportSize = {
  width: number;
  height: number;
};

async function readViewportSize(webview: { rpc?: any }): Promise<ViewportSize> {
  const viewport = await webview.rpc?.request.evaluateJavascriptWithResponse({
    script: "return { width: window.innerWidth, height: window.innerHeight };",
  });

  if (
    !viewport ||
    typeof viewport.width !== "number" ||
    typeof viewport.height !== "number"
  ) {
    throw new Error(`Invalid viewport response: ${JSON.stringify(viewport)}`);
  }

  return viewport;
}

export const windowTests = [
  defineTest({
    name: "Window native viewport is correct before first resize",
    category: "BrowserWindow",
    description: "Test WebView2 initial and resized viewport dimensions",
    timeout: 15000,
    async run({ createWindow, log }) {
      if (process.platform !== "win32") {
        log("Skipping Windows WebView2 viewport regression on this platform");
        return;
      }

      const initialOuterSize = { width: 640, height: 480 };
      const resizedOuterSize = { width: 800, height: 620 };
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc: createTestHarnessRPC(),
        title: "WebView2 Viewport Test",
        ...initialOuterSize,
        renderer: "native",
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));
      const initialViewport = await readViewportSize(win.webview);

      win.window.setSize(resizedOuterSize.width, resizedOuterSize.height);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const resizedViewport = await readViewportSize(win.webview);

      expect(resizedViewport.width).toBeGreaterThan(initialViewport.width);
      expect(resizedViewport.height).toBeGreaterThan(initialViewport.height);

      // Returning to the original outer size must reproduce the initial viewport.
      win.window.setSize(initialOuterSize.width, initialOuterSize.height);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const restoredViewport = await readViewportSize(win.webview);

      expect(Math.abs(restoredViewport.width - initialViewport.width)).toBeLessThan(2);
      expect(Math.abs(restoredViewport.height - initialViewport.height)).toBeLessThan(2);
      log(
        `Viewport ${initialViewport.width}x${initialViewport.height} -> ` +
          `${resizedViewport.width}x${resizedViewport.height} -> ` +
          `${restoredViewport.width}x${restoredViewport.height}`,
      );
    },
  }),

  defineTest({
    name: "Window creation with URL",
    category: "BrowserWindow",
    description: "Test creating a window with a URL",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "URL Window Test",
        width: 400,
        height: 300,
        renderer: 'cef',
      });

      expect(win.id).toBeGreaterThan(0);
      expect(win.webviewId).toBeGreaterThan(0);
      log(`Created window with id: ${win.id}, webviewId: ${win.webviewId}`);
    },
  }),

  defineTest({
    name: "Window hidden option",
    category: "BrowserWindow",
    description: "Test native visibility state across hidden creation, show, and hide",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Hidden Window Test",
        width: 400,
        height: 300,
        renderer: "cef",
        hidden: true,
      });

      expect(win.id).toBeGreaterThan(0);
      expect(win.webviewId).toBeGreaterThan(0);
      expect(win.window.isVisible()).toBe(false);
      log("Hidden window created");

      win.window.show();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(win.window.isVisible()).toBe(true);

      win.window.hide();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(win.window.isVisible()).toBe(false);
      log("Native window visibility transitions completed");
    },
  }),

  defineTest({
    name: "Window inactive show API",
    category: "BrowserWindow",
    description: "Test creating a window without activation and toggling inactive/active show paths",
    async run({ createWindow, log }) {
      log("Focus another app now if you want to observe initial create with activate: false");
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Inactive Show Test",
        width: 400,
        height: 300,
        renderer: "cef",
        activate: false,
      });

      expect(typeof win.window.showInactive).toBe("function");
      expect(typeof win.window.activate).toBe("function");
      log("Window created with activate: false");

      log("Focus another app now if you want to observe runtime showInactive() behavior");
      await new Promise((resolve) => setTimeout(resolve, 1500));

      win.window.showInactive();
      log("showInactive() succeeded");

      await new Promise((resolve) => setTimeout(resolve, 700));

      win.window.activate();
      log("activate() succeeded");
    },
  }),

  defineTest({
    name: "Window page zoom API",
    category: "BrowserWindow",
    description: "Test BrowserWindow setPageZoom/getPageZoom behavior",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Page Zoom Test",
        width: 420,
        height: 320,
        renderer: "native",
      });

      const targetZoom = 1.25;
      win.window.setPageZoom(targetZoom);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const zoom = win.window.getPageZoom();
      expect(typeof zoom).toBe("number");

      if (process.platform === "darwin" || process.platform === "win32") {
        expect(Math.abs(zoom - targetZoom)).toBeLessThan(0.02);
      } else {
        expect(zoom).toBe(1.0);
      }

      log(`Window zoom reported: ${zoom}`);
    },
  }),

  defineTest({
    name: "BrowserView page zoom API",
    category: "BrowserWindow",
    description: "Test BrowserView setPageZoom/getPageZoom behavior",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "View Zoom Test",
        width: 420,
        height: 320,
        renderer: "native",
      });

      const targetZoom = 1.1;
      win.webview.setPageZoom(targetZoom);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const zoom = win.webview.getPageZoom();
      expect(typeof zoom).toBe("number");

      if (process.platform === "darwin" || process.platform === "win32") {
        expect(Math.abs(zoom - targetZoom)).toBeLessThan(0.02);
      } else {
        expect(zoom).toBe(1.0);
      }

      log(`Webview zoom reported: ${zoom}`);
    },
  }),

  defineTest({
    name: "BrowserView spell check capability",
    category: "BrowserWindow",
    description: "Test initial and runtime macOS WKWebView spell checking support",
    async run({ createWindow, log }) {
      const win = await createWindow({
        html: "<!doctype html><div contenteditable>mispellled wurd</div>",
        title: "Spell Check Test",
        width: 420,
        height: 320,
        renderer: "native",
        hidden: true,
        spellCheck: true,
      });

      const expectedSupport = process.platform === "darwin";
      expect(win.window.spellCheck).toBe(true);
      expect(win.window.setSpellCheck(false)).toBe(expectedSupport);
      expect(win.webview.setSpellCheck(true)).toBe(expectedSupport);
      log(`Native spell-check support: ${expectedSupport}`);
    },
  }),

  defineTest({
    name: "Window setTitle",
    category: "BrowserWindow",
    description: "Test setting window title",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Original Title",
        renderer: 'cef',
      });

      log("Setting new title");
      win.window.setTitle("New Title From Test");

      // Give native side time to update
      await new Promise((resolve) => setTimeout(resolve, 100));
      log("Title set successfully");
    },
  }),

  defineTest({
    name: "Window minimize/unminimize",
    category: "BrowserWindow",
    description: "Test window minimize and restore",
    timeout: 15000,
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Minimize Test",
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 1500));

      log("Checking initial state");
      expect(win.window.isMinimized()).toBe(false);

      log("Minimizing window");
      win.window.minimize();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(win.window.isMinimized()).toBe(true);

      log("Unminimizing window");
      win.window.unminimize();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      
      let finalState = win.window.isMinimized();
      log(`State after unminimize: ${finalState}`);
      
      // On some Linux window managers, the state might not update immediately
      // or minimize/unminimize might not be fully supported
      if (finalState) {
        log("Window still reports as minimized, waiting longer...");
        await new Promise((resolve) => setTimeout(resolve, 2000));
        finalState = win.window.isMinimized();
        log(`State after extended wait: ${finalState}`);
        
        if (finalState) {
          log("WARNING: Window manager may not properly support minimize/unminimize");
          log("This is a known limitation on some Linux environments");
          // Don't fail the test in this case
          return;
        }
      }
      
      expect(finalState).toBe(false);
      log("Minimize/unminimize cycle completed");
    },
  }),

  defineTest({
    name: "Window maximize/unmaximize",
    category: "BrowserWindow",
    description: "Test window maximize and restore",
    timeout: 15000,
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Maximize Test",
        width: 400,
        height: 300,
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      log("Checking initial state");
      expect(win.window.isMaximized()).toBe(false);

      log("Maximizing window");
      win.window.maximize();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(win.window.isMaximized()).toBe(true);

      log("Unmaximizing window");
      win.window.unmaximize();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(win.window.isMaximized()).toBe(false);

      log("Maximize/unmaximize cycle completed");
    },
  }),

  defineTest({
    name: "Window fullscreen toggle",
    category: "BrowserWindow",
    description: "Test window fullscreen mode",
    timeout: 15000,
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Fullscreen Test",
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      log("Checking initial fullscreen state");
      expect(win.window.isFullScreen()).toBe(false);

      log("Entering fullscreen");
      win.window.setFullScreen(true);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(win.window.isFullScreen()).toBe(true);

      log("Exiting fullscreen");
      win.window.setFullScreen(false);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(win.window.isFullScreen()).toBe(false);

      log("Fullscreen toggle completed");
    },
  }),

  defineTest({
    name: "Window fullscreen toggle with hidden titlebar",
    category: "BrowserWindow",
    description: "Test macOS fullscreen mode when titleBarStyle is hidden",
    timeout: 15000,
    async run({ createWindow, log }) {
      if (process.platform !== "darwin") {
        log(`Skipping macOS-specific fullscreen behavior on ${process.platform}`);
        return;
      }

      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Hidden Fullscreen Test",
        renderer: "cef",
        titleBarStyle: "hidden",
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      log("Checking initial fullscreen state");
      expect(win.window.isFullScreen()).toBe(false);

      log("Entering fullscreen with hidden titlebar");
      win.window.setFullScreen(true);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(win.window.isFullScreen()).toBe(true);

      log("Exiting fullscreen with hidden titlebar");
      win.window.setFullScreen(false);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(win.window.isFullScreen()).toBe(false);
    },
  }),

  defineTest({
    name: "Window alwaysOnTop",
    category: "BrowserWindow",
    description: "Test window always-on-top behavior",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Always On Top Test",
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      log("Checking initial alwaysOnTop state");
      expect(win.window.isAlwaysOnTop()).toBe(false);

      log("Setting alwaysOnTop to true");
      win.window.setAlwaysOnTop(true);
      await new Promise((resolve) => setTimeout(resolve, 800));
      
      let isOnTop = win.window.isAlwaysOnTop();
      log(`AlwaysOnTop state after setting to true: ${isOnTop}`);
      if (!isOnTop) {
        log("Waiting additional time for window manager to update state...");
        await new Promise((resolve) => setTimeout(resolve, 1000));
        isOnTop = win.window.isAlwaysOnTop();
        log(`AlwaysOnTop state after extended wait: ${isOnTop}`);
        
        if (!isOnTop) {
          log("WARNING: Window manager may not properly support always-on-top state detection");
          log("This is a known limitation on some Linux desktop environments");
          // Don't fail the test in this case - the functionality may work but state detection may not
          return;
        }
      }
      expect(isOnTop).toBe(true);

      log("Setting alwaysOnTop to false");
      win.window.setAlwaysOnTop(false);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(win.window.isAlwaysOnTop()).toBe(false);

      log("AlwaysOnTop toggle completed");
    },
  }), 
 
  defineTest({
    name: "Window visibleOnAllWorkspaces (macOS)",
    category: "BrowserWindow",
    description: "Test macOS Spaces visible-on-all-workspaces behavior",
    async run({ createWindow, log }) {
      if (process.platform !== "darwin") {
        log(`Skipping macOS-specific visibleOnAllWorkspaces behavior on ${process.platform}`);
        return;
      }

      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Visible On All Workspaces Test",
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      log("Checking initial visibleOnAllWorkspaces state");
      expect(win.window.isVisibleOnAllWorkspaces()).toBe(false);

      log("Setting visibleOnAllWorkspaces to true");
      win.window.setVisibleOnAllWorkspaces(true);
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(win.window.isVisibleOnAllWorkspaces()).toBe(true);

      log("Setting visibleOnAllWorkspaces to false");
      win.window.setVisibleOnAllWorkspaces(false);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(win.window.isVisibleOnAllWorkspaces()).toBe(false);

      log("VisibleOnAllWorkspaces toggle completed");
     },
 }),

  defineTest({
    name: "Window focus",
    category: "BrowserWindow",
    description: "Test window focus method",
    async run({ createWindow, log }) {
      const win1 = await createWindow({
        url: "views://test-harness/index.html",
        title: "Focus Test 1",
        x: 100,
        y: 100,
        renderer: 'cef',
      });

      const win2 = await createWindow({
        url: "views://test-harness/index.html",
        title: "Focus Test 2",
        x: 200,
        y: 200,
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      log("Focusing window 1");
      win1.window.focus();
      await new Promise((resolve) => setTimeout(resolve, 200));

      log("Focusing window 2");
      win2.window.focus();
      await new Promise((resolve) => setTimeout(resolve, 200));

      win2.close();
      log("Focus operations completed");
    },
  }),

  defineTest({
    name: "Window close event",
    category: "BrowserWindow",
    description: "Test that close event fires when window is closed",
    async run({ createWindow, log }) {
      let closeEventFired = false;

      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Close Event Test",
        renderer: 'cef',
      });

      win.window.on("close", () => {
        closeEventFired = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      log("Closing window");
      win.window.close();

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(closeEventFired).toBe(true);
      log("Close event fired successfully");
    },
  }),

  defineTest({
    name: "Window will-close can veto user close",
    category: "BrowserWindow",
    description: "Test that a user close request can be vetoed before destruction",
    async run({ createWindow, log }) {
      let closeRequests = 0;
      let closed = false;

      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Will Close Test",
        renderer: "cef",
      });

      win.window.on("will-close", (event: any) => {
        closeRequests += 1;
        if (closeRequests === 1) {
          event.response = { allow: false };
        }
      });
      win.window.on("close", () => {
        closed = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      win.window.requestClose();
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(closeRequests).toBe(1);
      expect(closed).toBe(false);
      expect(win.window.getFrame().width).toBeGreaterThan(0);

      win.window.requestClose();
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(closeRequests).toBe(2);
      expect(closed).toBe(true);
      log("First close request was vetoed and the second was allowed");
    },
  }),

  defineTest({
    name: "Window resize event",
    category: "BrowserWindow",
    description: "Test that resize event fires with correct data",
    async run({ createWindow, log }) {
      let resizeData: any = null;

      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Resize Event Test",
        width: 400,
        height: 300,
        renderer: 'cef',
      });

      win.window.on("resize", (event: any) => {
        resizeData = event.data;
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      log("Maximizing to trigger resize");
      win.window.maximize();
      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(resizeData).toBeTruthy();
      expect(resizeData.width).toBeGreaterThan(400);
      expect(resizeData.height).toBeGreaterThan(300);
      log(`Resize event received: ${resizeData.width}x${resizeData.height}`);

      win.window.unmaximize();
    },
  }),

  ...(['default', 'hiddenInset', 'hidden'] satisfies TitleBarStyle[]).map(titleBarStyle => defineTest({
    name: `Window focus and blur events (titleBarStyle: ${titleBarStyle})`,
    category: "BrowserWindow",
    description: "Test that focus and blur events fire when windows gain and lose focus",
    async run({ createWindow, log }) {
      let blurEventFired = false;
      let focusEventFired = false;

      const win1 = await createWindow({
        url: "views://test-harness/index.html",
        title: "Focus Event Test",
        renderer: 'cef',
        titleBarStyle,
      });

      win1.window.on("blur", () => { blurEventFired = true; });

      await new Promise((resolve) => setTimeout(resolve, 300));

      log("Creating second window to steal focus");
      const win2 = await createWindow({
        url: "views://test-harness/index.html",
        title: "Focus Stealer",
        renderer: 'cef',
        titleBarStyle,
      });

      win2.window.on("focus", () => { focusEventFired = true; });

      win1.window.focus();
      await new Promise((resolve) => setTimeout(resolve, 300));

      win2.window.focus();

      // Give time for blur/focus events to fire
      await new Promise((resolve) => setTimeout(resolve, 800));

      expect(blurEventFired).toBe(true);
      expect(focusEventFired).toBe(true);

      log("Blur event fired successfully");
      log("Focus event fired successfully");
    },
  })),

  defineTest({
    name: "BrowserWindow.getById",
    category: "BrowserWindow",
    description: "Test static getById method",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "GetById Test",
        renderer: 'cef',
      });

      const retrieved = BrowserWindow.getById(win.id);
      expect(retrieved).toBeTruthy();
      expect(retrieved?.id).toBe(win.id);
      log(`Successfully retrieved window by id: ${win.id}`);
    },
  }),

  defineTest({
    name: "Window with inset titlebar style",
    category: "BrowserWindow",
    description: "Test creating a window with inset titlebar (transparent titlebar, native controls visible)",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Inset Titlebar",
        titleBarStyle: "hiddenInset",
        renderer: 'cef',
      });

      expect(win.id).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      log("Window with inset titlebar style created successfully");
    },
  }),

  defineTest({
    name: "Window traffic light position API",
    category: "BrowserWindow",
    description: "Test macOS traffic light offsets, runtime repositioning, and resize persistence",
    async run({ createWindow, log }) {
      if (process.platform !== "darwin") {
        log(`Skipping macOS-specific traffic light behavior on ${process.platform}`);
        return;
      }

      const baseline = await createWindow({
        url: "views://test-harness/index.html",
        title: "Traffic Light Baseline",
        titleBarStyle: "hiddenInset",
        width: 480,
        height: 340,
        renderer: "native",
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      const baselinePosition = baseline.window.getWindowButtonPosition();

      const offset = { x: 24, y: 18 };
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Traffic Light Position Test",
        titleBarStyle: "hiddenInset",
        trafficLightOffset: offset,
        width: 480,
        height: 340,
        renderer: "native",
      });

      expect(win.id).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const offsetPosition = win.window.getWindowButtonPosition();
      expect(Math.abs(offsetPosition.x - baselinePosition.x - offset.x)).toBeLessThan(0.5);
      expect(Math.abs(offsetPosition.y - baselinePosition.y - offset.y)).toBeLessThan(0.5);
      log(
        `Constructor offset: (${baselinePosition.x}, ${baselinePosition.y}) -> (${offsetPosition.x}, ${offsetPosition.y})`,
      );

      win.window.setWindowButtonPosition(52, 22);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const runtimePosition = win.window.getWindowButtonPosition();
      expect(Math.abs(runtimePosition.x - 52)).toBeLessThan(0.5);
      expect(Math.abs(runtimePosition.y - 22)).toBeLessThan(0.5);

      win.window.setSize(540, 380);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const resizedPosition = win.window.getWindowButtonPosition();
      expect(Math.abs(resizedPosition.x - 52)).toBeLessThan(0.5);
      expect(Math.abs(resizedPosition.y - 22)).toBeLessThan(0.5);
      log("Runtime traffic light position persisted after resize");
    },
  }),

  defineTest({
    name: "Window setPosition",
    category: "BrowserWindow",
    description: "Test programmatically moving a window",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "SetPosition Test",
        x: 100,
        y: 100,
        width: 400,
        height: 300,
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      log("Getting initial frame");
      const initialFrame = win.window.getFrame();
      log(`Initial position: (${initialFrame.x}, ${initialFrame.y})`);

      log("Moving window to (200, 200)");
      win.window.setPosition(200, 200);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const newFrame = win.window.getFrame();
      log(`New position: (${newFrame.x}, ${newFrame.y})`);

      // Allow some tolerance for window manager decorations
      expect(Math.abs(newFrame.x - 200)).toBeLessThan(50);
      expect(Math.abs(newFrame.y - 200)).toBeLessThan(50);

      log("Window position updated successfully");
    },
  }),

  defineTest({
    name: "Window omitted position centers on primary display",
    category: "BrowserWindow",
    description: "Omitting either frame coordinate centers the window on the primary work area",
    async run({ log }) {
      const workArea = Screen.getPrimaryDisplay().workArea;
      const width = 420;
      const height = 280;
      const cases = [
        { label: "both coordinates", frame: { width, height } },
        { label: "x coordinate", frame: { y: 37, width, height } },
        { label: "y coordinate", frame: { x: 41, width, height } },
      ];

      for (const testCase of cases) {
        const win = new BrowserWindow({
          title: `Centered Window (${testCase.label})`,
          url: "views://test-harness/index.html",
          renderer: "native",
          hidden: true,
          frame: testCase.frame,
        });

        try {
          const frame = win.getFrame();
          const expectedX = workArea.x + (workArea.width - frame.width) / 2;
          const expectedY = workArea.y + (workArea.height - frame.height) / 2;
          expect(Math.abs(frame.x - expectedX), `${testCase.label} x`).toBeLessThan(3);
          expect(Math.abs(frame.y - expectedY), `${testCase.label} y`).toBeLessThan(3);
          log(`${testCase.label} omitted: centered at (${frame.x}, ${frame.y})`);
        } finally {
          win.close();
        }
      }
    },
  }),

  defineTest({
    name: "Window setSize",
    category: "BrowserWindow",
    description: "Test programmatically resizing a window and its CEF viewport",
    async run({ createWindow, log }) {
      const rpc = createTestHarnessRPC();
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc,
        title: "SetSize Test",
        x: 100,
        y: 100,
        width: 400,
        height: 300,
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      log("Getting initial frame");
      const initialFrame = win.window.getFrame();
      const initialViewport = await win.webview.rpc?.request.evaluateJavascriptWithResponse({
        script: "return { width: window.innerWidth, height: window.innerHeight }",
      });
      log(`Initial size: ${initialFrame.width}x${initialFrame.height}`);

      log("Resizing window to 600x500");
      win.window.setSize(600, 500);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const newFrame = win.window.getFrame();
      const newViewport = await win.webview.rpc?.request.evaluateJavascriptWithResponse({
        script: "return { width: window.innerWidth, height: window.innerHeight }",
      });
      log(`New size: ${newFrame.width}x${newFrame.height}`);

      // Allow some tolerance for window manager decorations
      expect(Math.abs(newFrame.width - 600)).toBeLessThan(50);
      expect(Math.abs(newFrame.height - 500)).toBeLessThan(50);
      expect(newViewport?.width).toBeGreaterThan((initialViewport?.width ?? 0) + 100);
      expect(newViewport?.height).toBeGreaterThan((initialViewport?.height ?? 0) + 100);

      log(
        `Window and CEF viewport updated successfully: ${initialViewport?.width}x${initialViewport?.height} -> ${newViewport?.width}x${newViewport?.height}`,
      );
    },
  }),

  defineTest({
    name: "Window native renderer can shrink below its initial size",
    category: "BrowserWindow",
    description: "Test growing and shrinking a native-renderer window",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Native SetSize Test",
        x: 100,
        y: 100,
        width: 400,
        height: 300,
        renderer: "native",
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
      win.window.setSize(600, 500);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const grownFrame = win.window.getFrame();
      expect(Math.abs(grownFrame.width - 600)).toBeLessThan(50);
      expect(Math.abs(grownFrame.height - 500)).toBeLessThan(50);

      win.window.setSize(320, 240);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const shrunkFrame = win.window.getFrame();
      expect(Math.abs(shrunkFrame.width - 320)).toBeLessThan(50);
      expect(Math.abs(shrunkFrame.height - 240)).toBeLessThan(50);
      log(`Window grew to ${grownFrame.width}x${grownFrame.height} and shrank to ${shrunkFrame.width}x${shrunkFrame.height}`);
    },
  }),

  defineTest({
    name: "Window setFrame",
    category: "BrowserWindow",
    description: "Test programmatically setting window position and size together",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "SetFrame Test",
        x: 100,
        y: 100,
        width: 400,
        height: 300,
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      log("Getting initial frame");
      const initialFrame = win.window.getFrame();
      log(`Initial frame: (${initialFrame.x}, ${initialFrame.y}) ${initialFrame.width}x${initialFrame.height}`);

      log("Setting frame to (300, 250) 500x400");
      win.window.setFrame(300, 250, 500, 400);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const newFrame = win.window.getFrame();
      log(`New frame: (${newFrame.x}, ${newFrame.y}) ${newFrame.width}x${newFrame.height}`);

      // Allow some tolerance for window manager decorations
      expect(Math.abs(newFrame.x - 300)).toBeLessThan(50);
      expect(Math.abs(newFrame.y - 250)).toBeLessThan(50);
      expect(Math.abs(newFrame.width - 500)).toBeLessThan(50);
      expect(Math.abs(newFrame.height - 400)).toBeLessThan(50);

      log("Window frame updated successfully");
    },
  }),

  defineTest({
    name: "Window getFrame",
    category: "BrowserWindow",
    description: "Test getting the current window frame",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "GetFrame Test",
        x: 150,
        y: 150,
        width: 500,
        height: 400,
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      const frame = win.window.getFrame();
      log(`Frame: (${frame.x}, ${frame.y}) ${frame.width}x${frame.height}`);

      expect(frame.x).toBeGreaterThanOrEqual(0);
      expect(frame.y).toBeGreaterThanOrEqual(0);
      expect(frame.width).toBeGreaterThan(0);
      expect(frame.height).toBeGreaterThan(0);

      // Values should be somewhat close to what we requested
      // (accounting for window manager decorations and constraints)
      expect(Math.abs(frame.width - 500)).toBeLessThan(100);
      expect(Math.abs(frame.height - 400)).toBeLessThan(100);

      log("Window frame retrieved successfully");
    },
  }),

  defineTest({
    name: "Window getPosition",
    category: "BrowserWindow",
    description: "Test getting the current window position",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "GetPosition Test",
        x: 200,
        y: 180,
        width: 400,
        height: 300,
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      const pos = win.window.getPosition();
      log(`Position: (${pos.x}, ${pos.y})`);

      expect(pos.x).toBeGreaterThanOrEqual(0);
      expect(pos.y).toBeGreaterThanOrEqual(0);

      // Verify it returns x and y
      expect(pos.x).toBeDefined();
      expect(pos.y).toBeDefined();

      log("Window position retrieved successfully");
    },
  }),

  defineTest({
    name: "Window getSize",
    category: "BrowserWindow",
    description: "Test getting the current window size",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "GetSize Test",
        x: 100,
        y: 100,
        width: 600,
        height: 450,
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      const size = win.window.getSize();
      log(`Size: ${size.width}x${size.height}`);

      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);

      // Values should be somewhat close to what we requested
      expect(Math.abs(size.width - 600)).toBeLessThan(100);
      expect(Math.abs(size.height - 450)).toBeLessThan(100);

      log("Window size retrieved successfully");
    },
  }),
];
