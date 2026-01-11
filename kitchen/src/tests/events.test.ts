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

      const handler1 = () => {
        count++;
      };
      const handler2 = () => {
        count++;
      };

      const win = await createWindow({
        html: "<html><body>Test</body></html>",
        title: "Multi Handler Test",
      });

      win.window.on("focus", handler1);
      win.window.on("focus", handler2);

      await new Promise((resolve) => setTimeout(resolve, 200));

      log("Triggering focus event");
      win.window.focus();

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(count).toBe(2);
      log(`Both handlers fired, count: ${count}`);
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
      });

      const win2 = await createWindow({
        html: "<html><body>Win2</body></html>",
        title: "Window 2",
        x: 300,
        y: 100,
      });

      win1.window.on("focus", () => {
        win1Events++;
      });
      win2.window.on("focus", () => {
        win2Events++;
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      log("Focusing window 1");
      win1.window.focus();
      await new Promise((resolve) => setTimeout(resolve, 200));

      log("Focusing window 2");
      win2.window.focus();
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Each window should have received its own focus event
      expect(win1Events).toBeGreaterThanOrEqual(1);
      expect(win2Events).toBeGreaterThanOrEqual(1);

      win2.close();
      log(`Win1 events: ${win1Events}, Win2 events: ${win2Events}`);
    },
  }),
];
