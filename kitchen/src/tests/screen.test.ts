// Screen API Tests

import { defineTest, expect } from "../test-framework/types";
import { Screen } from "electrobun/bun";

export const screenTests = [
  defineTest({
    name: "getPrimaryDisplay",
    category: "Screen",
    description: "Test getting primary display information",
    async run({ log }) {
      const primary = Screen.getPrimaryDisplay();

      expect(primary).toBeTruthy();
      expect(primary.bounds).toBeTruthy();
      expect(primary.bounds.width).toBeGreaterThan(0);
      expect(primary.bounds.height).toBeGreaterThan(0);
      expect(primary.isPrimary).toBe(true);

      log(`Primary display: ${primary.bounds.width}x${primary.bounds.height}`);
      log(`Scale factor: ${primary.scaleFactor}x`);
      log(`Work area: ${primary.workArea.width}x${primary.workArea.height}`);
    },
  }),

  defineTest({
    name: "getAllDisplays",
    category: "Screen",
    description: "Test getting all connected displays",
    async run({ log }) {
      const displays = Screen.getAllDisplays();

      expect(Array.isArray(displays)).toBe(true);
      expect(displays.length).toBeGreaterThanOrEqual(1);

      // At least one should be primary
      const primaryCount = displays.filter((d) => d.isPrimary).length;
      expect(primaryCount).toBe(1);

      log(`Found ${displays.length} display(s)`);
      displays.forEach((display, i) => {
        log(
          `  Display ${i}: ${display.bounds.width}x${display.bounds.height} @ (${display.bounds.x}, ${display.bounds.y})`
        );
      });
    },
  }),

  defineTest({
    name: "getCursorScreenPoint",
    category: "Screen",
    description: "Test getting cursor position",
    async run({ log }) {
      const point = Screen.getCursorScreenPoint();

      expect(point).toBeTruthy();
      expect(typeof point.x).toBe("number");
      expect(typeof point.y).toBe("number");

      log(`Cursor position: (${point.x}, ${point.y})`);
    },
  }),

  defineTest({
    name: "Display bounds vs workArea",
    category: "Screen",
    description: "Test that workArea is within or equal to bounds",
    async run({ log }) {
      const primary = Screen.getPrimaryDisplay();

      // Work area should be <= bounds (accounts for dock, menu bar)
      expect(primary.workArea.width).toBeLessThanOrEqual(primary.bounds.width);
      expect(primary.workArea.height).toBeLessThanOrEqual(primary.bounds.height);

      log(`Bounds: ${primary.bounds.width}x${primary.bounds.height}`);
      log(`Work area: ${primary.workArea.width}x${primary.workArea.height}`);

      const dockSpace = primary.bounds.height - primary.workArea.height;
      log(`Space taken by dock/menubar: ${dockSpace}px vertical`);
    },
  }),
];
