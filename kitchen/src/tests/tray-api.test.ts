import { defineTest, expect } from "../test-framework/types";
import { Tray, Utils } from "electrobun/bun";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const trayApiTests = [
  defineTest({
    name: "Tray visibility toggle and bounds",
    category: "Tray",
    description: "Test tray.setVisible and tray.getBounds API behavior",
    timeout: 15000,
    async run({ log }) {
      const tray = new Tray({
        title: "Kitchen Tray API Test",
        image: "views://assets/electrobun-logo-32-template.png",
        template: true,
        width: 32,
        height: 32,
      });

      try {
        tray.setMenu([{ type: "normal", label: "Ping", action: "ping" }]);
        tray.setVisible(false);
        await wait(100);
        tray.setVisible(true);
        await wait(100);

        const bounds = tray.getBounds();
        expect(typeof bounds.x).toBe("number");
        expect(typeof bounds.y).toBe("number");
        expect(typeof bounds.width).toBe("number");
        expect(typeof bounds.height).toBe("number");
        log(
          `Tray bounds returned: x=${bounds.x}, y=${bounds.y}, width=${bounds.width}, height=${bounds.height}`,
        );
      } finally {
        tray.remove();
      }
    },
  }),

  defineTest({
    name: "Dock icon visibility contract",
    category: "Utils",
    description: "Test Utils.setDockIconVisible and Utils.isDockIconVisible",
    timeout: 12000,
    async run({ log }) {
      const initialVisible = Utils.isDockIconVisible();
      expect(typeof initialVisible).toBe("boolean");
      log(`Initial dock icon visibility: ${initialVisible}`);

      try {
        if (process.platform === "darwin") {
          Utils.setDockIconVisible(false);
          await wait(200);
          expect(Utils.isDockIconVisible()).toBe(false);

          Utils.setDockIconVisible(true);
          await wait(200);
          expect(Utils.isDockIconVisible()).toBe(true);
          log("Dock icon visibility toggled successfully on macOS");
        } else {
          Utils.setDockIconVisible(false);
          await wait(50);
          const afterToggle = Utils.isDockIconVisible();
          expect(typeof afterToggle).toBe("boolean");
          log(
            `Dock icon APIs are callable on ${process.platform} (stub behavior expected)`,
          );
        }
      } finally {
        Utils.setDockIconVisible(initialVisible);
      }
    },
  }),
];
