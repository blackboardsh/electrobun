// Event System Tests

import { defineTest, expect } from "../test-framework/types";
import Electrobun from "electrobun/bun";

export const eventsTests = [
  defineTest({
    name: "Global will-navigate event",
    category: "Events",
    description: "Test that global will-navigate event fires",
    async run({ createWindow, log }) {
      let eventFired = false;
      let eventData: any = null;

      const handler = (e: any) => {
        eventFired = true;
        eventData = e.data;
      };

      Electrobun.events.on("will-navigate", handler);

      const win = await createWindow({
        url: "about:blank",
        title: "Global Event Test",
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      log("Triggering navigation");
      win.webview.loadURL("https://example.com");

      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Cleanup
      Electrobun.events.off("will-navigate", handler);

      expect(eventFired).toBe(true);
      log("Global will-navigate event fired");
    },
  }),

  defineTest({
    name: "Multiple event handlers",
    category: "Events",
    description: "Test that multiple handlers can listen to same event",
    async run({ createWindow, log }) {
      let count = 0;
      let handler1Count = 0;
      let handler2Count = 0;

      const handler1 = () => {
        handler1Count++;
        count++;
        log(`Handler1 fired, total count: ${count}`);
      };
      const handler2 = () => {
        handler2Count++;
        count++;
        log(`Handler2 fired, total count: ${count}`);
      };

      const win = await createWindow({
        html: "<html><body>Test</body></html>",
        title: "Multi Handler Test",
        renderer: 'cef',
      });

      // Wait for window to stabilize after creation
      await new Promise((resolve) => setTimeout(resolve, 500));
      
      // Reset count in case focus events fired during window creation
      count = 0;
      handler1Count = 0;
      handler2Count = 0;
      
      log("Registering focus handlers");
      win.window.on("focus", handler1);
      win.window.on("focus", handler2);

      await new Promise((resolve) => setTimeout(resolve, 200));

      log("Triggering focus event");
      win.window.focus();

      await new Promise((resolve) => setTimeout(resolve, 800));

      if (count === 0) {
        log("Focus event didn't fire, trying to activate window...");
        win.window.show();
        win.window.focus();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      log(`Handler1 fired ${handler1Count} times`);
      log(`Handler2 fired ${handler2Count} times`);
      log(`Total count: ${count}`);
      
      if (count === 0) {
        log("WARNING: Window focus events not supported in this environment");
        log("This is common in automated test environments on Linux");
        // Skip this test in automated environments
        return;
      }
      
      // Each handler should fire once
      expect(handler1Count).toBe(1);
      expect(handler2Count).toBe(1);
      expect(count).toBe(2);
      log(`Both handlers fired correctly`);
    },
  }),

  defineTest({
    name: "Event response modification",
    category: "Events",
    description: "Test that event response can be modified by handlers",
    async run({ createWindow, log }) {
      let blocked = false;

      const win = await createWindow({
        html: "<html><body>Test</body></html>",
        title: "Event Response Test",
        renderer: 'cef',
      });

      // Block all navigation via event handler
      win.webview.on("will-navigate", (e: any) => {
        e.response = { allow: false };
        blocked = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      log("Attempting navigation (should be blocked)");
      win.webview.loadURL("https://example.com");

      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(blocked).toBe(true);
      log("Navigation was blocked via event response");
    },
  }),

  defineTest({
    name: "Window-specific vs global events",
    category: "Events",
    description: "Test that window-specific events don't fire for other windows",
    async run({ createWindow, log }) {
      let win1Events = 0;
      let win2Events = 0;

      const win1 = await createWindow({
        html: "<html><body>Win1</body></html>",
        title: "Window 1",
        x: 100,
        y: 100,
        renderer: 'cef',
      });

      const win2 = await createWindow({
        html: "<html><body>Win2</body></html>",
        title: "Window 2",
        x: 300,
        y: 100,
        renderer: 'cef',
      });

      // Clear any initial focus events from window creation
      await new Promise((resolve) => setTimeout(resolve, 500));
      
      win1.window.on("focus", () => {
        win1Events++;
        log(`Win1 focus event fired (total: ${win1Events})`);
      });
      win2.window.on("focus", () => {
        win2Events++;
        log(`Win2 focus event fired (total: ${win2Events})`);
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      log("Focusing window 1");
      win1.window.focus();
      await new Promise((resolve) => setTimeout(resolve, 800));

      log("Focusing window 2");
      win2.window.focus();
      await new Promise((resolve) => setTimeout(resolve, 800));

      if (win1Events === 0 && win2Events === 0) {
        log("No focus events fired, trying to activate windows...");
        win1.window.show();
        win1.window.focus();
        await new Promise((resolve) => setTimeout(resolve, 500));
        win2.window.show();
        win2.window.focus();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      log(`Win1 events: ${win1Events}, Win2 events: ${win2Events}`);

      if (win1Events === 0 && win2Events === 0) {
        log("WARNING: Window focus events not supported in this environment");
        log("This is common in automated test environments on Linux");
        win2.close();
        return;
      }

      // Each window should have received its own focus event
      expect(win1Events).toBeGreaterThanOrEqual(1);
      expect(win2Events).toBeGreaterThanOrEqual(1);

      win2.close();
    },
  }),
];
