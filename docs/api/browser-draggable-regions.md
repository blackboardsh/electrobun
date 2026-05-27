---
title: "Draggable Regions"
---

::: tip
Configure an html element to function as a draggable region allowing you to move the native application window by clicking and dragging on the element.
:::

When building desktop apps with Electrobun a common pattern is to create a frameless window, sometimes with the traffic light (close, minimize, maximize) buttons overlayed with the html content. You would then use html and css to create a top-bar and set that top-bar to be a draggable region allowing you full control over the style of the window.You can set any html element to be a draggable region.

### Step 1: Instantiate the Electroview class


```ts
// /src/mainview/index.ts
const electrobun = new Electroview();

```

### Step 2: Add the draggable region css class
Instantiating `Electroview()` will configure any element with the `electrobun-webkit-app-region-drag` css class as a draggable area.

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My Electrobun app</title>
    <script src="views://mainview/index.js"></script>
    <link rel="stylesheet" href="views://mainview/index.css" />
  </head>
  <body>
    click here and drag to move this window
    <h1>hi World</h1>
  </body>
</html>

```

### Step 3: Exclude interactive elements with no-drag
When you have interactive elements (like buttons) inside a draggable region, you need to exclude them from the drag behavior. Use the `electrobun-webkit-app-region-no-drag` css class to make elements non-draggable.

```html
<button class="close-btn" id="closeBtn"></button>
<button class="minimize-btn" id="minimizeBtn"></button>
<button class="maximize-btn" id="maximizeBtn"></button>
    My App

```

## Complete Custom Titlebar Example
Here's a complete example of implementing a custom titlebar with window controls when using `titleBarStyle: "hidden"`:**Bun process (src/bun/index.ts):**

```typescript
const rpc = BrowserView.defineRPC({
  handlers: {
    requests: {},
    messages: {
      closeWindow: () => win.close(),
      minimizeWindow: () => win.minimize(),
      maximizeWindow: () => {
if (win.isMaximized()) {
win.unmaximize();
} else {
win.maximize();
}
      },
    },
  },
});

const win = new BrowserWindow({
  title: "Custom Titlebar",
  url: "views://mainview/index.html",
  frame: { width: 800, height: 600, x: 100, y: 100 },
  titleBarStyle: "hidden",
  rpc,
});

```

**Browser process (src/mainview/index.ts):**

```typescript
const electrobun = new Electroview();

// Wire up window control buttons
document.getElementById("closeBtn")?.addEventListener("click", () => {
  electrobun.rpc.send.closeWindow();
});

document.getElementById("minimizeBtn")?.addEventListener("click", () => {
  electrobun.rpc.send.minimizeWindow();
});

document.getElementById("maximizeBtn")?.addEventListener("click", () => {
  electrobun.rpc.send.maximizeWindow();
});

```

**HTML (src/mainview/index.html):**

```html
<button class="close-btn" id="closeBtn"></button>
<button class="minimize-btn" id="minimizeBtn"></button>
<button class="maximize-btn" id="maximizeBtn"></button>
    My App
<main>
    
</main>

```

**CSS (src/mainview/index.css):**

```css
.titlebar {
    height: 32px;
    display: flex;
    align-items: center;
    padding: 0 12px;
    background: #2d2d2d;
    user-select: none;
}

.window-controls {
    display: flex;
    gap: 8px;
}

.window-controls button {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: none;
    cursor: pointer;
}

.close-btn { background: #ff5f57; }
.minimize-btn { background: #febc2e; }
.maximize-btn { background: #28c840; }

.title {
    flex: 1;
    text-align: center;
    font-size: 13px;
    color: #ccc;
}

```

::: tip
See the [BrowserWindow API](/api/browser-window) documentation for more details on `titleBarStyle` and `transparent` window options.
:::

