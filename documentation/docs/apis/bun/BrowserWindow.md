> Create and control browser windows

```typescript
// in the main process
import { BrowserWindow } from "electrobun/bun";

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

```
const win = new BrowserWindow({
  title: "my url window",
});
```

### frame

Set the window dimensions

```
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

```
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

This is an additional window configuration for OSX. This can be set to either `hiddenInset` or `default`. When setting it to `hiddenInset` it will also override `Titled` and `FullSizeContentView` to be `true`

```
const win = new BrowserWindow({
  title: "my url window",
  url: "views://mainview/index.html",
  frame: {
    width: 1800,
    height: 600,
    x: 2000,
    y: 2000,
  },
  titleBarStyle: 'hiddenInset',
  styleMask: {
    // In addition to the defaults, these will be forced to true when titleBarStyle
    // is set to hiddenInset
    Titled: true,
    FullSizeContentView: true,

  }
});

```

:::info
The following options are used to instantiate the default BrowserView
:::

### url

Set the initial url for the window's default BrowserView to navigate to when it opens.

```
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

Set an html string for the window's default BrowserView to load when it opens. Anything that would be valid in an html file including javascript and css can be used.

Use this instead of setting the `url` property.

```
const htmlString = "<html><head></head><body><h1>hello world</h1></body></html>";

const win = new BrowserWindow({
   html: htmlString,
});

```

### partition

Partitions allow you to separate the browser session. Things like cookies and so on. For example if you have two BrowserViews with the same partition and log into gmail in one, the other will also be logged into gmail. If you use two different partitions then you could log into a different gmail account in each BrowserView.

```
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

```
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

These RPC functions are asynchronous.

```typescript title="src/shared/types.ts"
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

```typescript title="src/bun/index.ts"
import { BrowserWindow, BrowserView } from "electrobun/bun";
import { type MyWebviewRPCType } from "../shared/types";

// Create an RPC object for the bun handlers with the shared type
const myWebviewRPC = BrowserView.defineRPC<MyWebviewRPC>({
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
const answer = await win.webview.rpc.someWebviewFunction(4, 6);

// Send a message to the BrowserView from bun
win.webview.rpc.logToBrowser("my message");
```

:::info
The above code snippet shows defining the bun process rpc handlers and calling the browser process handlers from bun. To see how to handle the Browser context code take a look at the [Browser API](/docs/apis/browser/Electroview%20Class)
:::


## Properties

### webview

This is a getter for the window's default [BrowserView](/docs/apis/bun/BrowserView)

```
const win = new BrowserWindow({
   ...
});

const defaultWebview = win.webview;

```

## Methods

### setTitle

Change the window title:

```
win.setTitle('new title')
```

### close

Close a window

```
win.close();
```

### on(name, handler)

Subscribe to BrowserWindow events (see below)

## Events

### close

When a window closes.

```
// listen to a specific window's close event
win.on('close', (event) => {
  const {id} = event.data;

  console.log('window closed')
});

// listen globally to window close events
import Electrobun from 'electrobun/bun';

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

```
// listen to a specific window's resize event
win.on("resize", (event) => {
  const { id, x, y, width, height } = event.data;
  console.log("window resized", id, x, y, width, height);
});

// listen globally to window resize events
import Electrobun from 'electrobun/bun';

Electrobun.events.on("resize", (event) => {
  const { id, x, y, width, height } = event.data;
  console.log("window resized", id, x, y, width, height);
});
```

### move

When a window's width or height changes

```
// listen to a specific window's move event
win.on("move", (event) => {
  const { id, x, y } = event.data;
  console.log("window moved", id, x, y);
});

// listen globally to window move events
import Electrobun from 'electrobun/bun';

Electrobun.eventson("move", (event) => {
  const { id, x, y } = event.data;
  console.log("window moved", id, x, y);
});
```
