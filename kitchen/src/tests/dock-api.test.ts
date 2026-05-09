import { defineTest, expect } from "../test-framework/types";
import { Dock } from "electrobun/bun";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Dock APIs are macOS-only — on Linux and Windows the native layer stubs them
// to no-op. These tests therefore verify the contract (calls are safe to make
// everywhere, no throw) rather than observable UI effects.
export const dockApiTests = [
  defineTest({
    name: "Dock.setMenu accepts configs and clears",
    category: "Dock",
    description: "Dock.setMenu should accept a menu array and an empty array without throwing",
    timeout: 8000,
    async run({ log }) {
      Dock.setMenu([
        { type: "normal", label: "Play", action: "toggle" },
        { type: "normal", label: "Next", action: "next" },
        { type: "divider" },
        { type: "normal", label: "Show", action: "show" },
      ]);
      await wait(100);

      Dock.setMenu([]);
      await wait(100);

      Dock.setMenu([
        { type: "normal", label: "Single", action: "only" },
      ]);
      await wait(100);

      log(
        process.platform === "darwin"
          ? "setMenu calls dispatched to NSApp.applicationDockMenu"
          : `setMenu is a no-op on ${process.platform} (stub behavior)`,
      );
    },
  }),

  defineTest({
    name: "Dock.setBadge accepts strings and clears",
    category: "Dock",
    description: "Dock.setBadge should accept text, null, and empty string without throwing",
    timeout: 6000,
    async run({ log }) {
      Dock.setBadge("3");
      await wait(50);
      Dock.setBadge("♪"); // ♪
      await wait(50);
      Dock.setBadge(null);
      await wait(50);
      Dock.setBadge("");
      await wait(50);
      Dock.setBadge(undefined);
      await wait(50);

      log(
        process.platform === "darwin"
          ? "badge label updated via NSDockTile"
          : `setBadge is a no-op on ${process.platform} (stub behavior)`,
      );
      expect(true).toBe(true);
    },
  }),

  defineTest({
    name: "Dock.setProgress accepts values and clears",
    category: "Dock",
    description: "Dock.setProgress should accept [0,1], null, and negative values without throwing",
    timeout: 6000,
    async run({ log }) {
      Dock.setProgress(0);
      await wait(50);
      Dock.setProgress(0.42);
      await wait(50);
      Dock.setProgress(1);
      await wait(50);
      Dock.setProgress(null);
      await wait(50);
      Dock.setProgress(undefined);
      await wait(50);
      // Out-of-range values should be clamped natively, not throw.
      Dock.setProgress(2);
      await wait(50);
      Dock.setProgress(-0.5);
      await wait(50);

      log(
        process.platform === "darwin"
          ? "progress overlay redraws via NSDockTile"
          : `setProgress is a no-op on ${process.platform} (stub behavior)`,
      );
      expect(true).toBe(true);
    },
  }),
];
