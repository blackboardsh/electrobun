---
sidebar_position: 3
title: Creating UI
sidebar_label: 3. Creating UI
slug: /guides/creating-ui
---

:::info
Continuing on from the [Hello World](/docs/guides/hello-world) Guide we're going to add some UI.
:::

Currently our app is opening a browser window and just loading a url. Let's make a simple web browser.

Let's create a new folder `src/main-ui/` and add an index file. This is where our browser code will go. The Electrobun cli will automatically transpile this into javascript and make it available at the url `views://main-ui/index.js`

```typescript title="src/main-ui/index.ts
import { Electroview } from "electrobun/view";

// Instantiate the electrobun browser api
const electrobun = new Electroview({ rpc: null });

window.loadPage = () => {
  const newUrl = document.querySelector("#urlInput").value;
  const webview = document.querySelector(".webview");

  webview.src = newUrl;
};

window.goBack = () => {
  const webview = document.querySelector(".webview");
  webview.goBack();
};

window.goForward = () => {
  const webview = document.querySelector(".webview");
  webview.goForward();
};
```

Let's create an html file to load into the BrowserView that will load the transpiled javascript above:

```html title="src/main-ui/index.html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>My Web Browser</title>
    <script src="views://main-ui/index.js"></script>
</head>
<body>
    <h1>My Web Browser</h1>
    <input type="text" id="urlInput" placeholder="Enter URL">
    <button onclick="loadPage()">Go</button>
    <button onclick="goBack()">Back</button>
    <button onclick="goForward()">Forward</button>

    <electrobun-webview class="webview" width="100%" height="100%" src="https://electrobun.dev">

</body>
</html>
```

Now let's update our `electrobun.config.ts` file so that it knows to transpile the new typescript and html files for our main-ui:

```typescript title="electrobun.config.ts"
export default {
  app: {
    name: "My App",
    identifier: "dev.my.app",
    version: "0.0.1",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      "main-ui": {
        entrypoint: "src/main-ui/index.ts",
      },
    },
    copy: {
      "src/main-ui/index.html": "views/main-ui/index.html",
    },
  },
};
```

And finally let's update our bun process code to load the new html file:

```typescript title="src/bun/index.ts"
import { BrowserWindow } from "electrobun/bun";

const win = new BrowserWindow({
  title: "Hello Electrobun",
  url: "views://main-ui/index.html",
});
```

Now back in terminal `ctrl+c` if it was running and then `bun start` to rebuild and launch. You should now see a window with an input, type in `https://google.com` and hit go, then try the back and forward buttons.

You'll notice that while you can right click on the text input and choose copy and paste from the default context menu. `cmd+c` and `cmd+v` as well as `cmd+a` to select all don't work. Let's update our main bun file to set up an Application Edit menu to enable those keyboard shortcuts.

```typescript title="src/bun/index.ts"
import { BrowserWindow, ApplicationMenu } from "electrobun/bun";

ApplicationMenu.setApplicationMenu([
  {
    submenu: [{ label: "Quit", role: "quit" }],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      {
        label: "Custom Menu Item  🚀",
        action: "custom-action-1",
        tooltip: "I'm a tooltip",
      },
      {
        label: "Custom menu disabled",
        enabled: false,
        action: "custom-action-2",
      },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { role: "selectAll" },
    ],
  },
]);

const win = new BrowserWindow({
  title: "Hello Electrobun",
  url: "views://main-ui/index.html",
});
```

You'll notice now that when the app is focused your app now has an Edit menu, and because we used `role:` for the `cut`, `copy`, `paste`, and `selectAll` menu items those global keyboard shortcuts will now work in your app's url input.

:::info Congratulations
You just built a simple web browser in Electrobun!
:::
