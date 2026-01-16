// Preload Script Tests

import { defineTest, expect } from "../test-framework/types";

export const preloadTests = [
  defineTest({
    name: "Preload script with data URL",
    category: "Preload",
    description: "Test that preload scripts with data URLs are accepted",
    async run({ createWindow, log }) {
      const preloadScript = `
        window.__preloadRan = true;
        window.__preloadTime = Date.now();
      `;

      const html = `
        <!DOCTYPE html>
        <html>
        <head><title>Preload Test</title></head>
        <body>
          <h1>Preload Test</h1>
        </body>
        </html>
      `;

      // Just verify that the window can be created with a preload script
      // We can't verify the script ran without RPC, but we can verify no errors
      const win = await createWindow({
        html,
        preload: `data:text/javascript;base64,${btoa(preloadScript)}`,
        title: "Preload Test",
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify window was created
      expect(win.id).toBeGreaterThan(0);
      log("Window with preload script created successfully");
    },
  }),

  defineTest({
    name: "Preload with external URL",
    category: "Preload",
    description: "Test preload script works with external URLs",
    async run({ createWindow, log }) {
      const preloadScript = `
        window.__preloadWithExternalUrl = true;
      `;

      // Create window with external URL and preload
      // We're just testing that this combination doesn't error
      const win = await createWindow({
        url: "https://example.com",
        preload: `data:text/javascript;base64,${btoa(preloadScript)}`,
        title: "Preload External URL Test",
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Verify window was created
      expect(win.id).toBeGreaterThan(0);
      log("Window with preload and external URL created successfully");
    },
  }),

  defineTest({
    name: "Preload script DOM manipulation",
    category: "Preload",
    description: "Test that preload can register for DOM events",
    async run({ createWindow, log }) {
      // Preload that adds a DOMContentLoaded listener
      const preloadScript = `
        window.addEventListener('DOMContentLoaded', () => {
          console.log('Preload DOMContentLoaded handler ran');
        });
      `;

      const html = `
        <!DOCTYPE html>
        <html>
        <body>
          <h1>Original Content</h1>
        </body>
        </html>
      `;

      // Just verify no errors when creating with DOM manipulation preload
      const win = await createWindow({
        html,
        preload: `data:text/javascript;base64,${btoa(preloadScript)}`,
        title: "Preload DOM Test",
        renderer: 'cef',
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify window was created
      expect(win.id).toBeGreaterThan(0);
      log("Window with DOM manipulation preload created successfully");
    },
  }),
];
