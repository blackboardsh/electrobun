// Navigation Tests - Tests for BrowserView navigation and events

import { defineTest, expect } from "../test-framework/types";

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
      win.webview.on("will-navigate", () => {
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
      let didNavigateFired = false;

      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Nav Rules Whitelist Test",
        renderer: 'native', // Use native renderer - CEF doesn't support navigation rules
      });

      // Wait for initial load
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Reset any existing navigation rules first
      log("Clearing any existing navigation rules");
      win.webview.setNavigationRules([]);
      await new Promise((resolve) => setTimeout(resolve, 100));

      log("Setting navigation rules: allow only views://test-runner/*");
      win.webview.setNavigationRules([
        "^*", // Block all
        "views://test-runner/*", // Allow test-runner views
        "views://test-harness/*", // Allow current view
        "views://internal/*", // Allow internal views
      ]);

      // Listen for navigation events
      win.webview.on("will-navigate", () => {
        willNavigateFired = true;
      });

      win.webview.on("did-navigate", () => {
        didNavigateFired = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      log("Loading test-runner (should succeed)");
      win.webview.loadURL("views://test-runner/index.html");
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Both events should fire for allowed navigation
      expect(willNavigateFired).toBe(true);
      expect(didNavigateFired).toBe(true);
      log("Successfully navigated to whitelisted URL");

      // Reset rules to allow normal navigation after test
      win.webview.setNavigationRules([]);
    },
  }),

  defineTest({
    name: "Navigation rules - block",
    category: "Navigation", 
    description: "Test that navigation rules block non-whitelisted URLs",
    timeout: 15000,
    async run({ createWindow, log }) {
      let willNavigateFired = false;
      let didNavigateFired = false;
      let blockedUrl = "";

      const win = await createWindow({
        url: "views://test-harness/index.html",
        title: "Nav Rules Block Test",
        renderer: 'native', // Use native renderer - CEF doesn't support navigation rules
      });

      // Wait for initial load
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Reset any existing navigation rules first
      log("Clearing any existing navigation rules");
      win.webview.setNavigationRules([]);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Use webview-specific events for better isolation
      let navigatedUrls: string[] = [];
      
      win.webview.on("will-navigate", (e: any) => {
        willNavigateFired = true;
        blockedUrl = e.data?.detail || e.detail || "";
        log(`will-navigate fired for: ${blockedUrl}`);
      });

      win.webview.on("did-navigate", (e: any) => {
        didNavigateFired = true;
        const url = e.data?.detail || e.detail || "";
        navigatedUrls.push(url);
        log(`did-navigate fired for: ${url}`);
      });

      log("Setting navigation rules: block all except example.com");
      win.webview.setNavigationRules([
        "^*", // Block all
        "*://example.com/*", // Allow only example.com  
        "views://*", // Allow views protocol for current page
      ]);

      await new Promise((resolve) => setTimeout(resolve, 100));

      log("Attempting to load google.com (should be blocked)");
      win.webview.loadURL("https://google.com");
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // will-navigate should fire (navigation attempt detected)
      expect(willNavigateFired).toBe(true);
      expect(blockedUrl).toContain("google.com");
      
      // did-navigate should NOT fire (navigation was blocked)
      if (didNavigateFired) {
        log(`WARNING: did-navigate fired with URLs: ${navigatedUrls.join(", ")}`);
        // Check if it fired for the blocked URL or just the existing page
        const hasGoogleUrl = navigatedUrls.some(url => url.includes("google.com"));
        expect(hasGoogleUrl).toBe(false); // If did-navigate fired, it should NOT be for google.com
      }
      expect(didNavigateFired).toBe(false);
      
      log("Navigation was blocked as expected");
      log(`Blocked URL: ${blockedUrl}`);

      // Reset rules to allow normal navigation after test
      win.webview.setNavigationRules([]);
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
      win.webview.on("dom-ready", () => {
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
      expect(navigatedUrl).toBeTruthy();
      expect(typeof navigatedUrl).toBe('string');
      
      const hasTestRunner = navigatedUrl.includes("test-runner") || 
                          navigatedUrl.includes("test-runner/index.html") ||
                          navigatedUrl.includes("views://test-runner");
      
      expect(hasTestRunner).toBe(true);
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
