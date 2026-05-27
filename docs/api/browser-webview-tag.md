---
title: "Electrobun Webview Tag"
---

## Introduction
Electrobun's custom webview tag implementation behaves similarly to an enhanced iframe, but with key differences in capabilities and isolation. It serves as a positional anchor within the DOM, communicating with a Zig backend to manage a distinct, isolated BrowserView. This separation ensures full content isolation from the host webview, enhancing both security and performance.

## Basic Usage

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>webview tag test</title>
    <script src="views://webviewtag/index.js"></script>
  </head>

  <body>
    <electrobun-webview src="https://electrobun.dev"></electrobun-webview>
  </body>
</html>

```

## Compatibility
The Electrobun webview tag integrates seamlessly with any reactive JavaScript framework, such as React or SolidJS, allowing for dynamic interactions and updates without disrupting the isolation of the webview's contents.The way the implementation currently works, the html element is just a positional anchor that reports its position and relays events to zig which manages a completely separate BrowserView and overlays it at the same coordinates within the window.On Linux, passthrough and mask punch-through behavior for overlaid webview tags is not supported inside transparent `BrowserWindow`s. Transparent CEF windows are rendered offscreen into the parent X11 window, so native overlay children cannot reliably hit-test through themselves into the host DOM. Use a non-transparent window for masked/passthrough overlays on Linux.On Windows, passthrough and mask punch-through behavior is not supported on WebView2-backed webviews. WebView2 renders through an Intermediate D3D Window that bypasses the Windows compositor in a way that makes `SetWindowRgn`-based hole-cutting and `WS_EX_TRANSPARENT`-based hit-test passthrough ineffective. Enable `bundleCEF: true` so the webview tag is backed by CEF, which exposes a browser HWND that respects these APIs and supports both masks and passthrough on Windows.

## How is this different to Electron's webview tag

### Chrome plans to deprecate their webview tag
Electron's webview tag is based on a Chrome feature/api designed for Chrome apps which has been deprecated since 2020. You can read about that on [Electron's Github](https://github.com/electron/electron/issues/34356) and in [Chrome's developer docs](https://developer.chrome.com/docs/apps/reference/webviewTag). The warning declares it "remains supported for Enterprise and Education customers on ChromeOS until at least Jan 2025" which is fast approaching.It's unknown what Electron will do when and if Chrome actually removes webview tag support from Chrome.Unlike Electron's reliance on Chrome's now-deprecated webview tag, Electrobun introduces its own robust implementation that does not depend on Chrome's lifecycle. This independence ensures longevity and stability for applications using Electrobun's framework, even as Chrome phases out its support.

### Electrobun's webview tag is a separate layer
Because Electrobun's webview tag implementation uses a div anchor and then positions a separate isolated BrowserView above the parent BrowserView there are some interesting edge cases where you may want to click on the parent document or do things within the parent DOM, so Electrobun provides various special methods for handling those situations. For example ways to mirror a screenshot of the webview tag's contents to the host's anchor and hide it or stream an image of the contents.

## Mask Selectors
Because the embedded webview is a separate native layer painted on top of the host page, normal DOM stacking (`z-index`, absolute positioning, fixed headers, dropdown menus, modals) cannot draw over it — the OOPIF always wins. Mask selectors solve this. You give the webview tag a list of CSS selectors that match elements in the host page, and Electrobun cuts holes in the embedded webview wherever those elements land, every frame. The host page paints through the holes, and clicks/scrolls in those regions hit the host element instead of the embedded content.This is what makes interactive host-page UI on top of an OOPIF possible: tooltips, autocomplete popovers, context menus, sidebars that overlap the webview, drag handles, custom title bars — anything that needs to visually and interactively sit above the embedded content.Selectors are re-evaluated on every layout sync (`document.querySelectorAll` per selector), so as your overlay elements move, resize, mount, or unmount, the holes follow them automatically. There is no need to manually notify the webview when an overlay's geometry changes.You can declare selectors statically with the `masks` attribute (comma-separated), or add and remove them imperatively at runtime:

```html
<electrobun-webview
  src="https://electrobun.dev"
  masks=".host-tooltip, #app-sidebar, .dropdown-menu"
></electrobun-webview>

I render and receive clicks on top of the OOPIF...```

```ts
const webview = document.querySelector('electrobun-webview');

// Add a selector at runtime — any matching element starts overlaying immediately
webview.addMaskSelector('.context-menu');

// Remove it when the overlay is no longer needed
webview.removeMaskSelector('.context-menu');

```

**Notes:**

- A selector can match zero, one, or many elements — every match becomes its own hole.

- Holes use each matched element's bounding rect, so transforms, rounded corners, and partial transparency on the overlay itself are not reflected in the cutout shape.

- Invalid selectors are silently ignored rather than throwing.

- The set of active selectors is exposed as the `maskSelectors` property if you need to inspect or iterate it.

## Properties and Attributes

### src
**Type:** `string`

**Description:** URL of the web page to load in the webview.

### html
**Type:** `string`

**Description:** HTML content to be directly loaded into the webview, useful for dynamic content generation.

### preload
**Type:** `string`

**Description:** Path to a script that should be preloaded before any other scripts run in the webview.

### partition
**Type:** `string`

**Description:** Sets a partition to provide separate storage for different sessions, useful in multi-user applications.

### sandbox
**Type:** `boolean`

**Description:** When set to true, creates the webview in sandbox mode. Sandbox mode disables RPC communication and only allows event emission, making it suitable for loading untrusted third-party content securely.**Security Model:** In sandbox mode:

- Events (dom-ready, did-navigate, will-navigate, etc.) still work normally

- Navigation controls (loadURL, goBack, goForward, reload) still work

- RPC communication is completely disabled - no messages can be sent between the webview and your application code

- The webview content cannot access any application APIs or trigger custom handlers

```html
<electrobun-webview
  src="https://untrusted-site.com"
  sandbox
></electrobun-webview>

<electrobun-webview
  id="sandbox-webview"
  src="https://example.com"
  sandbox
></electrobun-webview>

<script>
  // Navigation rules still work with sandboxed webviews
  document.getElementById('sandbox-webview').setNavigationRules([
    "^*",                        // Block everything by default
    "*://example.com/*",         // Allow example.com
    "*://cdn.example.com/*",     // Allow CDN
  ]);

  // Events still work in sandbox mode
  document.getElementById('sandbox-webview').on('did-navigate', (e) => &#123;
    console.log('Sandboxed webview navigated to:', e.detail.url);
  &#125;);
</script>

```

### transparent
**Type:** `boolean`

**Description:** When set to true, makes the webview transparent, allowing underlying elements to be visible.

### passthroughEnabled
**Type:** `boolean`

**Description:** Enables or disables mouse and touch events to pass through to underlying elements.

### masks
**Type:** `string` (comma-separated CSS selectors)

**Description:** Initial set of host-page CSS selectors to mask out of the embedded webview. Matching elements punch interactive holes through the OOPIF so host-page UI can render and receive input on top of it. See [Mask Selectors](#mask-selectors) for the full explanation.

### maskSelectors
**Type:** `Set<string>`

**Description:** Runtime set of active mask selectors. Populated from the `masks` attribute on init and mutated by `addMaskSelector` / `removeMaskSelector`. Read it to inspect what is currently masked; prefer the methods over mutating the set directly so a sync is triggered.

### hidden
**Type:** `boolean`

**Description:** Controls the visibility of the webview.

### webviewId
**Type:** `number`

**Description:** A unique identifier for the webview instance, automatically managed by the system.

### id
**Type:** `string`

**Description:** The DOM ID for the webview element, automatically set to ensure uniqueness.

## Methods

### canGoBack
**Returns:** `Promise<boolean>`

**Description:** Determines if the webview can navigate backward.

### canGoForward
**Returns:** `Promise<boolean>`

**Description:** Determines if the webview can navigate forward.

### on
**Parameters:** `event: WebviewEventTypes, listener: () => {}`

**Description:** Attach event listeners for webview-specific events such as navigation and loading.

### off
**Parameters:** `event: WebviewEventTypes, listener: () => {}`

**Description:** Detach event listeners for webview-specific events.

### syncDimensions
**Parameters:** `force: boolean = false`

**Description:** Synchronizes the dimensions and position of the webview with its anchor element in the DOM, optionally forcing an update.

### goBack
**Description:** Navigates the webview back to the previous page.

### goForward
**Description:** Navigates the webview forward to the next page.

### reload
**Description:** Reloads the current content in the webview.

### loadURL
**Parameters:** `url: string`

**Description:** Loads a given URL into the webview, similar to setting the `src` attribute.

### setNavigationRules
**Parameters:** `rules: string[]`

**Description:** Set an allow/block list of URL patterns to control which URLs the webview can navigate to. Rules are evaluated synchronously in native code for maximum performance.
**Rule Format:**

- Rules use glob-style wildcards where `*` matches any characters

- Prefix a rule with `^` to make it a block rule

- Rules without the `^` prefix are allow rules

- Rules are evaluated top-to-bottom, last matching rule wins

- If no rule matches, navigation is allowed by default

```ts
// Block everything except specific domains
document.querySelector('electrobun-webview').setNavigationRules([
  "^*",                           // Block everything by default
  "*://en.wikipedia.org/*",       // Allow Wikipedia
  "*://upload.wikimedia.org/*",   // Allow Wikipedia images
]);

// Allow everything except specific domains
document.querySelector('electrobun-webview').setNavigationRules([
  "^*://malware.com/*",           // Block malware.com
  "^http://*",                    // Block all non-HTTPS
]);

```

### executeJavascript
**Parameters:** `js: string`

**Description:** Execute arbitrary JavaScript in the webview. This is a fire-and-forget method that does not return a result. The JavaScript is dispatched to the webview's native process for execution.

```ts
// Modify content in the nested webview
document.querySelector('electrobun-webview').executeJavascript(
  'document.body.innerHTML = "<h1>Modified</h1>"'
);

// Run any JavaScript in the nested webview
document.querySelector('electrobun-webview').executeJavascript(
  'document.title = "New Title"'
);

```

### toggleTransparent
**Parameters:** `value?: boolean`

**Description:** Toggles the transparency state of the webview.

### togglePassthrough
**Parameters:** `value?: boolean`

**Description:** Toggles the ability for mouse and touch events to pass through the webview.

### toggleHidden
**Parameters:** `value?: boolean`

**Description:** Toggles the visibility of the webview.

### addMaskSelector
**Parameters:** `selector: string`

**Description:** Adds a CSS selector to the active mask set and forces an immediate sync so any matching host-page elements start punching through the embedded webview right away. Safe to call repeatedly with the same selector — the underlying set deduplicates. See [Mask Selectors](#mask-selectors).

### removeMaskSelector
**Parameters:** `selector: string`

**Description:** Removes a previously added selector from the active mask set and forces an immediate sync. The selector string must match exactly what was passed to `addMaskSelector` (or what came from the `masks` attribute). No-op if the selector is not in the set.

## Events
Use the `on` method to listen for events from the webview. Events are dispatched as CustomEvents with details in the `detail` property.

### dom-ready
**Description:** Fired when the DOM of the webview's content has finished loading.

### did-navigate
**Description:** Fired when the webview navigates to a new URL.

### did-navigate-in-page
**Description:** Fired for in-page navigations (e.g., hash changes).

### did-commit-navigation
**Description:** Fired when the webview commits to navigating to a new URL.

### new-window-open
**Description:** Fired when the webview attempts to open a new window (e.g., via `window.open()` or a link with `target="_blank"`).

### host-message
**Description:** Fired when the webview's preload script sends a message to the host using `window.__electrobunSendToHost()`. The message payload is available in `event.detail`.

```ts
// Listen for messages from the webview's preload script
document.querySelector('electrobun-webview').on('host-message', (event) => &#123;
  console.log('Received message from webview:', event.detail);
  // event.detail contains the message object sent from the preload
&#125;);

```

## Preload Scripts
Preload scripts run in the context of the webview before any page scripts execute. They have access to special APIs for communicating with the host.

### window.__electrobunSendToHost(message)
**Parameters:** `message: any` (will be JSON serialized)

**Description:** Sends a message from the webview's preload script to the host BrowserWindow. The message will be received via the `host-message` event on the webview element.This enables secure communication from nested webviews back to the parent page, allowing preload scripts to forward user interactions, keyboard events, or custom data.

```html
<electrobun-webview
  id="myWebview"
  src="https://example.com"
  preload="
    // Forward click events to the host
    document.addEventListener('click', (e) => &#123;
      window.__electrobunSendToHost(&#123;
type: 'click',
target: e.target.tagName,
x: e.clientX,
y: e.clientY
      &#125;);
    &#125;);

    // Forward keyboard events to the host
    document.addEventListener('keydown', (e) => &#123;
      window.__electrobunSendToHost(&#123;
type: 'keydown',
key: e.key,
code: e.code,
ctrlKey: e.ctrlKey,
shiftKey: e.shiftKey,
altKey: e.altKey,
metaKey: e.metaKey
      &#125;);
    &#125;);
  "
></electrobun-webview>

<script>
  document.getElementById('myWebview').on('host-message', (event) => &#123;
    const msg = event.detail;
    if (msg.type === 'keydown') &#123;
      console.log('Key pressed in webview:', msg.key);
      // Handle the keyboard event in the host context
    &#125;
  &#125;);
</script>

```

**Note:** The `__electrobunSendToHost` function is only available inside preload scripts running within an `electrobun-webview`. It is not available in regular page scripts.

## Security Considerations
When embedding third-party content in your application, security is paramount. Electrobun provides multiple layers of protection:

### Sandbox Mode
Always use `sandbox` attribute when loading untrusted content. This completely disables RPC communication, preventing the loaded content from accessing any application APIs.

```html
<electrobun-webview
  src="https://untrusted-third-party.com"
  sandbox
></electrobun-webview>

```

### Navigation Rules
Combine sandbox mode with navigation rules to restrict where the webview can navigate. This prevents redirects to malicious sites.

```ts
const webview = document.querySelector('electrobun-webview');

// Strict allowlist approach
webview.setNavigationRules([
  "^*",                              // Block everything by default
  "*://trusted-domain.com/*",        // Allow specific trusted domains
  "*://cdn.trusted-domain.com/*",    // Allow associated CDNs
]);

```

### Process Isolation
Each `electrobun-webview` runs in a completely separate browser process. This provides:

- **Memory isolation:** Malicious content cannot read memory from your application

- **Crash isolation:** If the embedded content crashes, your application continues running

- **Security boundary:** Browser exploits are contained within the isolated process

### Best Practices

- **Always sandbox untrusted content:** Use the `sandbox` attribute for any content you don't fully control

- **Use navigation rules:** Restrict navigation to prevent redirects to malicious sites

- **Use partitions:** Isolate session storage between different webviews to prevent data leakage

- **Validate host messages:** If using preload scripts with `__electrobunSendToHost`, always validate and sanitize received messages

- **Prefer HTTPS:** Block HTTP content with navigation rules to ensure encrypted connections

```html
<electrobun-webview
  id="secure-webview"
  src="https://third-party-widget.com"
  sandbox
  partition="third-party-widget"
></electrobun-webview>

<script>
  const webview = document.getElementById('secure-webview');

  // Restrict navigation
  webview.setNavigationRules([
    "^http://*",                         // Block all HTTP (require HTTPS)
    "^*",                                // Block everything else by default
    "*://third-party-widget.com/*",      // Allow the widget domain
  ]);

  // Monitor navigation for security events
  webview.on('did-navigate', (e) => &#123;
    console.log('Navigation:', e.detail.url);
  &#125;);
</script>

```

