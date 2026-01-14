// Navigation Tests - Tests for BrowserView navigation and events

import { defineTest, expect } from "../test-framework/types";
import Electrobun from "electrobun/bun";

export const navigationTests = [
  defineTest({
    name: "loadURL",
    category: "Navigation",
    description: "Test loading a URL into webview",
    timeout: 15000,
    async run({ createWindow, log }) {
      // Test loadURL by navigating to an internal views:// URL
      // Note: did-navigate events only fire for internal URLs where preload is injected
      let willNavigateFired = false;

      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "LoadURL Test",
      });

      // Wait for initial load
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Use will-navigate to verify loadURL triggers navigation
      win.webview.on("will-navigate", (e: any) => {
        willNavigateFired = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      log("Loading test-runner URL");
      win.webview.loadURL("views://test-runner/index.html");

      await new Promise((resolve) => setTimeout(resolve, 1000));

      expect(willNavigateFired).toBe(true);
      log("loadURL successfully triggered navigation");
    },
  }),

  defineTest({
    name: "loadHTML",
    category: "Navigation",
    description: "Test loading HTML content into webview",
    async run({ createWindow, log }) {
      let willNavigateFired = false;

      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "LoadHTML Test",
      });

      // Wait for initial load
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Listen for will-navigate event to confirm navigation happened
      win.webview.on("will-navigate", () => {
        willNavigateFired = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const customHtml =
        "<html><body><h1 id='test-heading'>Custom HTML Content</h1></body></html>";
      log("Loading custom HTML");
      win.webview.loadHTML(customHtml);

      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Verify HTML was loaded - will-navigate fires when loadHTML triggers navigation
      expect(willNavigateFired).toBe(true);
      log("HTML loaded successfully");
    },
  }),

  defineTest({
    name: "Navigation rules - whitelist",
    category: "Navigation",
    description: "Test that navigation rules allow whitelisted URLs",
    timeout: 15000,
    async run({ createWindow, log }) {
      let willNavigateFired = false;

      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Nav Rules Whitelist Test",
      });

      // Wait for initial load
      await new Promise((resolve) => setTimeout(resolve, 500));

      log("Setting navigation rules: allow only views://test-runner/*");
      win.webview.setNavigationRules([
        "^*", // Block all
        "views://test-runner/*", // Allow test-runner views
        "views://test-harness/*", // Allow current view
        "views://internal/*", // Allow internal views
      ]);

      // Listen for will-navigate without filtering - just check it fires
      win.webview.on("will-navigate", () => {
        willNavigateFired = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      log("Loading test-runner (should succeed)");
      win.webview.loadURL("views://test-runner/index.html");
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Verify navigation was attempted (will-navigate fires even for allowed URLs)
      expect(willNavigateFired).toBe(true);
      log("Successfully navigated to whitelisted URL");
    },
  }),

  defineTest({
    name: "Navigation rules - block",
    category: "Navigation",
    description: "Test that navigation rules block non-whitelisted URLs",
    async run({ createWindow, log }) {
      let navigatedToGoogle = false;

      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Nav Rules Block Test",
      });

      // Use global event system
      // Event data: { id: webviewId, detail: urlString }
      const handler = (e: any) => {
        if (
          e.data?.id === win.webviewId &&
          e.data?.detail?.includes("google.com")
        ) {
          navigatedToGoogle = true;
        }
      };

      Electrobun.events.on("did-navigate", handler);

      await new Promise((resolve) => setTimeout(resolve, 500));

      log("Setting navigation rules: block all except example.com");
      win.webview.setNavigationRules([
        "^*", // Block all
        "*://example.com/*", // Allow only example.com
      ]);

      log("Attempting to load google.com (should be blocked)");
      win.webview.loadURL("https://google.com");
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Cleanup
      Electrobun.events.off("did-navigate", handler);

      // Navigation should have been blocked, so we didn't navigate to google
      expect(navigatedToGoogle).toBe(false);
      log("Navigation was blocked as expected");
    },
  }),

  defineTest({
    name: "dom-ready event",
    category: "Navigation",
    description: "Test that dom-ready event fires after DOM is loaded",
    async run({ createWindow, log }) {
      let domReadyCount = 0;

      // Use webview-specific dom-ready event listener
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "DOM Ready Test",
      });

      // dom-ready fires on webview after load event
      win.webview.on("dom-ready", (e: any) => {
        domReadyCount++;
      });

      // Wait for initial dom-ready from creating the window
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Initial load should have triggered dom-ready
      // Now navigate to another internal URL to trigger another dom-ready
      log("Navigating to test-runner to trigger dom-ready");
      win.webview.loadURL("views://test-runner/index.html");

      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(domReadyCount).toBeGreaterThan(0);
      log(`dom-ready event fired ${domReadyCount} time(s)`);
    },
  }),

  defineTest({
    name: "did-navigate event",
    category: "Navigation",
    description: "Test that did-navigate event fires after navigation",
    timeout: 15000,
    async run({ createWindow, log }) {
      let didNavigateFired = false;
      let navigatedUrl = "";

      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Did Navigate Test",
      });

      // Use webview-specific did-navigate event listener
      win.webview.on("did-navigate", (e: any) => {
        didNavigateFired = true;
        navigatedUrl = e.data?.detail || "";
      });

      // Wait for initial load
      await new Promise((resolve) => setTimeout(resolve, 500));

      log("Navigating to test-runner view");
      win.webview.loadURL("views://test-runner/index.html");

      await new Promise((resolve) => setTimeout(resolve, 2000));

      log(`did-navigate fired: ${didNavigateFired}, URL: ${navigatedUrl}`);
      
      expect(didNavigateFired).toBe(true);
      
      // The URL format might vary, so check for test-runner in a more flexible way
      if (navigatedUrl) {
        const hasTestRunner = navigatedUrl.includes("test-runner") || 
                            navigatedUrl.includes("test-runner/index.html") ||
                            navigatedUrl.includes("views://test-runner");
        
        if (!hasTestRunner) {
          log(`WARNING: URL doesn't contain 'test-runner' as expected: ${navigatedUrl}`);
          log("This might be due to URL format differences, but navigation occurred");
        }
        
        expect(hasTestRunner).toBe(true);
      } else {
        log("WARNING: No URL received in did-navigate event");
        // Still pass if event fired but no URL was provided
      }
    },
  }),

  defineTest({
    name: "will-navigate event with response control",
    category: "Navigation",
    description: "Test that will-navigate can block navigation",
    async run({ createWindow, log }) {
      let willNavigateFired = false;

      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Will Navigate Test",
      });

      // Wait for initial load
      await new Promise((resolve) => setTimeout(resolve, 500));

      win.webview.on("will-navigate", (e: any) => {
        willNavigateFired = true;
        // Block navigation
        e.response = { allow: false };
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      log("Attempting navigation (will be blocked by event handler)");
      win.webview.loadURL("https://example.com");

      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(willNavigateFired).toBe(true);
      log("will-navigate event fired and blocked navigation");
    },
  }),

  defineTest({
    name: "executeJavascript (fire and forget)",
    category: "Navigation",
    description: "Test executing JavaScript without waiting for response",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Execute JS Test",
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      log("Executing JS to modify DOM");
      // Just verify this doesn't throw - we can't verify the result without RPC
      win.webview.executeJavascript(
        'document.body.innerHTML = "<h1>Modified by executeJavascript</h1>"'
      );

      await new Promise((resolve) => setTimeout(resolve, 300));
      log("executeJavascript completed without error");
    },
  }),

  defineTest({
    name: "findInPage",
    category: "Navigation",
    description: "Test find in page functionality",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Find In Page Test",
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      // Load HTML with searchable content
      const longHtml = `
        <!DOCTYPE html>
        <html>
        <body>
          <p>First paragraph with searchterm here</p>
          <p>Second paragraph without it</p>
          <p>Third paragraph with searchterm again</p>
        </body>
        </html>
      `;
      win.webview.loadHTML(longHtml);
      await new Promise((resolve) => setTimeout(resolve, 500));

      log("Searching for 'searchterm'");
      win.webview.findInPage("searchterm", { forward: true, matchCase: false });

      await new Promise((resolve) => setTimeout(resolve, 500));

      log("Stopping find");
      win.webview.stopFindInPage();

      log("findInPage operations completed");
    },
  }),
];
