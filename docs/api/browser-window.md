---
title: "BrowserWindow API"
---

# BrowserWindow API

  <blockquote>
Create and control browser windows
  </blockquote>

```typescript
// in the main process
const win = new BrowserWindow({
  title: "my url window",
  frame: {
    width: 1800,
    height: 600,
    x: 2000,
    y: 2000,
  },
  url: "views://mainview/index.html",
});

```

## Constructor Options

### title

Set the title of the window.

```ts
const win = new BrowserWindow({
  title: "my url window",
});

```

### frame

Set the window dimensions.

```ts
const win = new BrowserWindow({
   frame: {
    width: 1800,
    height: 600,
    x: 2000,
    y: 2000,
  },
});

```

### styleMask

This controls the OSX window appearance and functionality. You can set the following:

```ts
const win = new BrowserWindow({
  title: "my url window",
  url: "views://mainview/index.html",
  frame: {
    width: 1800,
    height: 600,
    x: 2000,
    y: 2000,
  },
  styleMask: {
    // These are the current defaults
    Borderless: false,
    Titled: true,
    Closable: true,
    Miniaturizable: true,
    Resizable: true,
    UnifiedTitleAndToolbar: false,
    FullScreen: false,
    FullSizeContentView: false,
    UtilityWindow: false,
    DocModalWindow: false,
    NonactivatingPanel: false,
    HUDWindow: false,
  }
});

```

### titleBarStyle

Controls the window's title bar appearance. This option works across all platforms (macOS, Windows, and Linux).Available values:

- `"default"` - Normal title bar with native window controls (close, minimize, maximize buttons)

- `"hidden"` - No title bar, no native window controls. Use this for fully custom window chrome where you implement your own title bar and window controls in HTML/CSS

- `"hiddenInset"` - Transparent title bar with inset native controls. On macOS, this shows the traffic light buttons overlaid on your content. On other platforms, this behaves similarly to `hidden`

```ts
// Default title bar
const win = new BrowserWindow({
  title: "Standard Window",
  url: "views://mainview/index.html",
  titleBarStyle: "default",
});

// Hidden title bar for fully custom chrome
const customWin = new BrowserWindow({
  title: "Custom Titlebar",
  url: "views://mainview/index.html",
  titleBarStyle: "hidden",
});

// Hidden inset - transparent titlebar with traffic lights (macOS)
const insetWin = new BrowserWindow({
  title: "Inset Window",
  url: "views://mainview/index.html",
  titleBarStyle: "hiddenInset",
});

```

When using `titleBarStyle: "hidden"` or `"hiddenInset"`, you'll typically want to create a custom title bar in your HTML. See the [Draggable Regions](/api/browser-draggable-regions) documentation for making your custom title bar draggable, and use the window control methods (`close()`, `minimize()`, `maximize()`) to implement custom window buttons.
::: tip
The `titleBarStyle` option automatically configures the underlying `styleMask` properties. When set to `"hiddenInset"`, it forces `Titled: true` and `FullSizeContentView: true`. When set to `"hidden"`, it forces `Titled: false` and `FullSizeContentView: true`.
:::

### activate

Controls whether the window should take focus when it is first shown. The default is `true`. Set `activate: false` for palette windows, tray popovers, or other UI that should open without stealing focus.

```ts
const palette = new BrowserWindow({
  title: "Command Palette",
  url: "views://palette/index.html",
  frame: { width: 420, height: 520, x: 200, y: 120 },
  activate: false,
});

```

::: tip
`activate` only affects the initial auto-show during window creation. To reveal an existing hidden window without taking focus, use `showInactive()`.
:::

### trafficLightOffset

macOS-only. Offsets the native traffic light buttons when using `titleBarStyle: "hiddenInset"`. This is ignored on Windows and Linux.

```ts
const win = new BrowserWindow({
  title: "Inset Window",
  url: "views://mainview/index.html",
  titleBarStyle: "hiddenInset",
  trafficLightOffset: {
    x: 12,
    y: 10,
  },
});

```

### transparent

When set to `true`, the window background becomes transparent, allowing you to create non-rectangular windows, floating widgets, or windows with rounded corners and drop shadows.

```ts
const floatingWidget = new BrowserWindow({
  title: "Floating Widget",
  url: "views://widget/index.html",
  frame: { width: 300, height: 200, x: 100, y: 100 },
  titleBarStyle: "hidden",
  transparent: true,
});

```

For transparency to work correctly, your HTML/CSS must also have a transparent background:

```css
/* In your CSS */
html, body {
  background: transparent;
}

/* Create a visible floating card */
.floating-card {
  background: rgba(30, 30, 50, 0.95);
  border-radius: 16px;
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
}

```

::: tip
Transparent windows are typically combined with `titleBarStyle: "hidden"` to achieve floating widget effects. The `transparent` option works across all platforms and with both the native WebKit and CEF renderers.
:::

### sandbox

When set to `true`, the webview runs in sandbox mode. This disables RPC (remote procedure calls) and only allows event emission. Use sandbox mode for displaying untrusted content like remote URLs where you want to prevent malicious sites from accessing internal APIs.

```ts
// Sandboxed window for untrusted content
const externalBrowser = new BrowserWindow({
  title: "External Browser",
  url: "https://example.com",
  sandbox: true,  // Disable RPC for security
});

// Events still work in sandbox mode
externalBrowser.webview.on("dom-ready", () => {
  console.log("Page loaded");
});

externalBrowser.webview.on("will-navigate", (event) => {
  console.log("Navigating to:", event.data.detail);
});

```

**Security Model:**

- **Events work** - Navigation events (`will-navigate`, `did-navigate`, `dom-ready`, etc.) still fire normally

- **RPC is disabled** - The `rpc` option is ignored; no function calls between browser and main process

- **No webview tags** - Sandboxed webviews cannot create nested `<electrobun-webview>` elements (OOPIFs)

- **Navigation controls work** - You can still use `loadURL()`, `goBack()`, `goForward()`, etc.
::: tip
Sandbox mode uses a minimal preload script that only sets up event emission. This prevents any code in the webview from communicating with your main process beyond basic lifecycle events.
:::

#### When to use sandbox mode

- Loading external/untrusted URLs (e.g., user-provided links, third-party content)

- Building a web browser or content viewer that displays arbitrary websites

- Embedding documentation or help content from external sources

- Any scenario where you want the webview isolated from your application's internals

#### Using sandbox with &lt;electrobun-webview&gt; tag

You can also create sandboxed nested webviews using the `sandbox` attribute:

```html
<electrobun-webview
  src="https://untrusted-site.com"
  sandbox
  style="width: 100%; height: 500px;"
></electrobun-webview>

```

**Info:** The following options are used to instantiate the default BrowserView.

### url

Set the initial url for the window's default BrowserView to navigate to when it opens.

```ts
// Use any url on the internet
const win = new BrowserWindow({
   url: "https://electrobun.dev",
});

// or use the views:// url scheme to load local
// content that you've bundled with your app.

const win = new BrowserWindow({
   url: "views://mainview/index.html",
});

```

### html

Set an html string for the window's default BrowserView to load when it opens. Anything that would be valid in an html file including javascript and css can be used. Use this instead of setting the `url` property.

```ts
const htmlString = "<html><head></head><body><h1>hello world</h1></body></html>";

const win = new BrowserWindow({
   html: htmlString,

});

```

### partition

Partitions allow you to separate the browser session. Things like cookies and so on. For example if you have two BrowserViews with the same partition and log into gmail in one, the other will also be logged into gmail. If you use two different partitions then you could log into a different gmail account in each BrowserView.

```ts
// ephemeral partition. If you close and reopen your app
// even if you use the same partition name it will not
// have persisted.
const win = new BrowserWindow({
   partition: "partition1",
});

// To make partitions persistent just prefix it with `persist:`
const win = new BrowserWindow({
   partition: "persist:partition1",
});

```

### preload

Set a preload script for the window's default BrowserView to render after html is parsed but before any other javascript is executed. The preload script will be run after any navigation before the page's scripts are run.
You can use either inline javascript or a url.

```ts
// Use any url on the internet
const win = new BrowserWindow({
   preload: "https://electrobun.dev/some/remote/file.js",
});

// or use the views:// preload scheme to load local
// content that you've bundled with your app.

const win = new BrowserWindow({
   preload: "views://somebundledview/preloadscript.js",
});

// or use inline javascript

const win = new BrowserWindow({
   preload: "document.body.innerHTML = 'Hello world'; console.log('hello console')",
});

```

### rpc

The RPC property allows you to establish RPC (remote procedure calls) between the bun process and this window's default BrowserView. In other words it lets you define functions that execute in the bun process that are callable and return a value back to the browser process and visa versa.
These RPC functions are asynchronous.`src/shared/types.ts`

```typescript
export type MyWebviewRPCType = {
  // functions that execute in the main process
  bun: RPCSchema<{
    requests: {
      someBunFunction: {
params: {
a: number;
b: number;
};
response: number;
      };
    };
    messages: {
      logToBun: {
msg: string;
      };
    };
  }>;
  // functions that execute in the browser context
  webview: RPCSchema<{
    requests: {
      someWebviewFunction: {
params: {
a: number;
b: number;
};
response: number;
      };
    };
    messages: {
      logToWebview: {
msg: string;
      };
    };
  }>;
};

```

`src/bun/index.ts`

```typescript
// Create an RPC object for the bun handlers with the shared type
const myWebviewRPC = BrowserView.defineRPC<MyWebviewRPCType>({
  maxRequestTime: 5000,
  handlers: {
    requests: {
      someBunFunction: ({ a, b }) => {
console.log(`browser asked me to do math with: ${a} and ${b}`);
return a + b;
      },
    },
    // When the browser sends a message we can handle it
    // in the main bun process
    messages: {
      "*": (messageName, payload) => {
console.log("global message handler", messageName, payload);
      },
      logToBun: ({ msg }) => {
console.log("Log to bun: ", msg);
      },
    },
  },
});

// Pass the RPC object to the BrowserWindow, which will set it
// on the window's default BrowserView
const win = new BrowserWindow({
  title: "my window",
  url: "views://mainview/index.html",
  frame: {
    width: 1800,
    height: 600,
    x: 2000,
    y: 2000,
  },
  rpc: myWebviewRPC,
});

// ... later on

// Note: These RPC methods will inherit types from the shared type

// Call a browser function from bun
const answer = await win.webview.rpc.request.someWebviewFunction({ a: 4, b: 6 });

// Send a message to the BrowserView from bun
win.webview.rpc.send.logToWebview({ msg: "my message" });

```

**Info:** The above code snippet shows defining the bun process rpc handlers and calling the browser process handlers from bun. To see how to handle the Browser context code take a look at the [Electroview Class (Browser API)](/api/browser-electroview).

## Properties

### webview

This is a getter for the window's default [BrowserView](/api/browser-view).

```ts
const win = new BrowserWindow({
   ...
});

const defaultWebview = win.webview;

```

## Methods

### setTitle

Change the window title:

```ts
win.setTitle('new title')

```

### close

Close a window.

```ts
win.close();

```

### show / showInactive / activate / hide

Control window visibility and focus. `show()` shows and activates the window. `showInactive()` shows it without activating it. `activate()` focuses an already-visible window. `hide()` hides the window without closing it.

```ts
const win = new BrowserWindow({
  title: "Palette",
  url: "views://palette/index.html",
  hidden: true,
  activate: false,
});

// Reveal without stealing focus
win.showInactive();

// Later, explicitly bring it to the front
win.activate();

// Hide without closing
win.hide();

// Show and activate
win.show();

```

### focus (deprecated)

`focus()` is a deprecated alias for `activate()`. Existing code still works, but prefer `activate()` in new code.

```ts
// Old
win.focus();

// New
win.activate();

```

### minimize / unminimize / isMinimized

Control and check the minimized state of a window.

```ts
// Minimize the window
win.minimize();

// Restore from minimized state
win.unminimize();

// Check if window is minimized
if (win.isMinimized()) {
  console.log("Window is minimized");
}

```

### maximize / unmaximize / isMaximized

Control and check the maximized state of a window. On macOS, this uses the "zoom" functionality which fills the screen while keeping the menu bar visible.

```ts
// Maximize the window
win.maximize();

// Restore from maximized state
win.unmaximize();

// Check if window is maximized
if (win.isMaximized()) {
  console.log("Window is maximized");
}

```

### setFullScreen / isFullScreen

Control and check the fullscreen state of a window. Fullscreen mode hides the title bar and dock/taskbar.

```ts
// Enter fullscreen mode
win.setFullScreen(true);

// Exit fullscreen mode
win.setFullScreen(false);

// Check if window is in fullscreen
if (win.isFullScreen()) {
  console.log("Window is in fullscreen mode");
}

// Toggle fullscreen
win.setFullScreen(!win.isFullScreen());

```

### setAlwaysOnTop / isAlwaysOnTop

Control and check whether a window stays above all other windows. Useful for floating tools, overlays, or picture-in-picture style windows.

```ts
// Make window always on top
win.setAlwaysOnTop(true);

// Disable always on top
win.setAlwaysOnTop(false);

// Check if window is always on top
if (win.isAlwaysOnTop()) {
  console.log("Window is pinned above other windows");
}

// Toggle always on top
win.setAlwaysOnTop(!win.isAlwaysOnTop());

```

### setPosition(x, y)

Move the window to a specific position on screen. Coordinates use a top-left origin (0, 0 is the top-left corner of the screen).

```ts
// Move window to position (200, 150)
win.setPosition(200, 150);

// Center window on screen (approximate)
const screenWidth = 1920;  // Get actual screen dimensions
const screenHeight = 1080;
const frame = win.getFrame();
win.setPosition(
  (screenWidth - frame.width) / 2,
  (screenHeight - frame.height) / 2
);

```

### setSize(width, height)

Resize the window to specific dimensions. The window's top-left corner position is preserved.

```ts
// Resize window to 800x600
win.setSize(800, 600);

// Make window square based on current width
const frame = win.getFrame();
win.setSize(frame.width, frame.width);

```

### setFrame(x, y, width, height)

Set both position and size of the window in a single call. This is more efficient than calling `setPosition` and `setSize` separately when you need to change both.

```ts
// Move and resize window in one call
win.setFrame(100, 100, 1024, 768);

// Restore window to a saved position/size
const savedFrame = { x: 200, y: 150, width: 800, height: 600 };
win.setFrame(savedFrame.x, savedFrame.y, savedFrame.width, savedFrame.height);

```

### setWindowButtonPosition(x, y)

macOS-only. Reposition the native traffic light buttons at runtime. This is most useful with `titleBarStyle: "hiddenInset"`. On Windows and Linux the method is available but does nothing.

```ts
const win = new BrowserWindow({
  title: "Inset Window",
  url: "views://mainview/index.html",
  titleBarStyle: "hiddenInset",
});

win.setWindowButtonPosition(16, 12);

```

### getFrame()

Get the current position and size of the window. Returns an object with `x`, `y`, `width`, and `height` properties.

```ts
// Get current window frame
const frame = win.getFrame();
console.log(`Position: (${frame.x}, ${frame.y})`);
console.log(`Size: ${frame.width}x${frame.height}`);

// Save and restore window frame
const savedFrame = win.getFrame();
// ... later
win.setFrame(savedFrame.x, savedFrame.y, savedFrame.width, savedFrame.height);

```

### getPosition()

Get the current position of the window. Returns an object with `x` and `y` properties.

```ts
// Get current window position
const pos = win.getPosition();
console.log(`Window is at (${pos.x}, ${pos.y})`);

// Check if window is at origin
const { x, y } = win.getPosition();
if (x === 0 && y === 0) {
  console.log("Window is at origin");
}

```

### getSize()

Get the current size of the window. Returns an object with `width` and `height` properties.

```ts
// Get current window size
const size = win.getSize();
console.log(`Window is ${size.width}x${size.height}`);

// Check aspect ratio
const { width, height } = win.getSize();
const aspectRatio = width / height;
console.log(`Aspect ratio: ${aspectRatio.toFixed(2)}`);

```

### setVisibleOnAllWorkspaces / isVisibleOnAllWorkspaces

Control and check whether a window is visible on all virtual desktops/workspaces. This is useful for utility windows, floating tools, or widgets that should remain accessible across all spaces.

```ts
// Make window visible on all workspaces
win.setVisibleOnAllWorkspaces(true);

// Restrict to current workspace
win.setVisibleOnAllWorkspaces(false);

// Check if window is visible on all workspaces
if (win.isVisibleOnAllWorkspaces()) {
  console.log("Window is visible on all workspaces");
}

```

::: tip
This feature is fully supported on macOS (uses `NSWindowCollectionBehaviorCanJoinAllSpaces`). On Windows and Linux, the methods are available but are no-ops.
:::

### setPageZoom / getPageZoom

Control and get the page zoom level for the window's webview. A value of `1.0` represents 100% zoom.

```ts
// Set zoom to 150%
win.setPageZoom(1.5);

// Get current zoom level
const zoom = win.getPageZoom();
console.log(`Current zoom: ${zoom * 100}%`);

// Reset to default zoom
win.setPageZoom(1.0);

```

::: tip
Page zoom is fully supported on macOS (WebKit). On Windows and Linux (CEF), these methods are available but are no-ops &mdash; `getPageZoom()` will always return `1.0`.
:::

### on(name, handler)

Subscribe to BrowserWindow events (see below).

## Events

### close

When a window closes. Per-window close handlers fire before global close handlers, ensuring your handlers run before the internal `exitOnLastWindowClosed` logic.

```ts
// listen to a specific window's close event
win.on('close', (event) => {
  const {id} = event.data;

  console.log('window closed')
});

// listen globally to window close events
Electrobun.events.on('close', (event) => {
  const {id} = event.data;

  if (win.id === id) {
    console.log('my window closed');
  } else {
    console.log(`some other window with id ${id}` closed);
  }
});

```

### resize

When a window's width or height changes. This events sends the x and y as part of the data because a window may be resized by dragging the top-left corner which would also reposition it.

```ts
// listen to a specific window's resize event
win.on("resize", (event) => {
  const { id, x, y, width, height } = event.data;
  console.log("window resized", id, x, y, width, height);
});

// listen globally to window resize events
Electrobun.events.on("resize", (event) => {
  const { id, x, y, width, height } = event.data;
  console.log("window resized", id, x, y, width, height);
});

```

### move

When a window's position changes.

```ts
// listen to a specific window's move event
win.on("move", (event) => {
  const { id, x, y } = event.data;
  console.log("window moved", id, x, y);
});

// listen globally to window move events
Electrobun.events.on("move", (event) => {
  const { id, x, y } = event.data;
  console.log("window moved", id, x, y);
});

```

### focus

When a window becomes the key window (receives focus). This is useful for tracking which window should receive keyboard shortcuts or other focus-dependent actions.

```ts
// listen to a specific window's focus event
win.on("focus", (event) => {
  const { id } = event.data;
  console.log("window focused", id);
});

// listen globally to window focus events
Electrobun.events.on("focus", (event) => {
  const { id } = event.data;
  console.log("window focused", id);
});

```

### blur

When a window loses focus (is no longer the key window).

```ts
// listen to a specific window's blur event
win.on("blur", (event) => {
  const { id } = event.data;
  console.log("window lost focus", id);
});

// listen globally to window blur events
Electrobun.events.on("blur", (event) => {
  const { id } = event.data;
  console.log("window lost focus", id);
});

```
