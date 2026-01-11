// BrowserWindow Tests - Tests for window creation and management

import { defineTest, expect } from "../test-framework/types";
import { BrowserWindow } from "electrobun/bun";

export const windowTests = [
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
      });

      expect(win.id).toBeGreaterThan(0);
      expect(win.webviewId).toBeGreaterThan(0);
      log(`Created window with id: ${win.id}, webviewId: ${win.webviewId}`);
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
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      log("Checking initial state");
      expect(win.window.isMinimized()).toBe(false);

      log("Minimizing window");
      win.window.minimize();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(win.window.isMinimized()).toBe(true);

      log("Unminimizing window");
      win.window.unminimize();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(win.window.isMinimized()).toBe(false);

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
    name: "Window alwaysOnTop",
    category: "BrowserWindow",
    description: "Test window always-on-top behavior",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Always On Top Test",
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      log("Checking initial alwaysOnTop state");
      expect(win.window.isAlwaysOnTop()).toBe(false);

      log("Setting alwaysOnTop to true");
      win.window.setAlwaysOnTop(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(win.window.isAlwaysOnTop()).toBe(true);

      log("Setting alwaysOnTop to false");
      win.window.setAlwaysOnTop(false);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(win.window.isAlwaysOnTop()).toBe(false);

      log("AlwaysOnTop toggle completed");
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
      });

      const win2 = await createWindow({
        url: "views://test-harness/index.html",
        title: "Focus Test 2",
        x: 200,
        y: 200,
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

  defineTest({
    name: "Window focus event",
    category: "BrowserWindow",
    description: "Test that focus event fires when window gains focus",
    async run({ createWindow, log }) {
      let focusEventFired = false;

      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Focus Event Test",
      });

      win.window.on("focus", () => {
        focusEventFired = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      log("Triggering focus");
      win.window.focus();
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(focusEventFired).toBe(true);
      log("Focus event fired successfully");
    },
  }),

  defineTest({
    name: "BrowserWindow.getById",
    category: "BrowserWindow",
    description: "Test static getById method",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "GetById Test",
      });

      const retrieved = BrowserWindow.getById(win.id);
      expect(retrieved).toBeTruthy();
      expect(retrieved?.id).toBe(win.id);
      log(`Successfully retrieved window by id: ${win.id}`);
    },
  }),

  defineTest({
    name: "Window with hiddenInset titleBarStyle",
    category: "BrowserWindow",
    description: "Test creating a window with hidden title bar",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Hidden Title Bar",
        titleBarStyle: "hiddenInset",
      });

      expect(win.id).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      log("Window with hiddenInset title bar created successfully");
    },
  }),
];
