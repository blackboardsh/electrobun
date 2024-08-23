> Create and control browser views (sometimes referred to as webviews).

:::info
Instead of creating BrowserViews directly from the bun process, you would use the [BrowserWindow](/docs/apis/bun/BrowserWindow) class which automatically creates a default BrowserView that fills the window, and then use [WebviewTags](/docs/apis/browser/Electrobun%20Webview%20Tag) within your html to create nested BrowserViews from the browser context.
:::

```typescript
// Most use cases: Access webview created by BrowserWindow or WebviewTag
import { BrowserView } from "electrobun/bun";
const webview = BrowserView.getById(id);

// or

const win = new BrowserWindow(/*....*/);

const webview = win.webview;

// or

// advnaced use cases: Create BrowserView directly
import { BrowserWindow } from "electrobun/bun";

const webview = new BrowserView({
  url: "views://mainview/index.html",
  frame: {
    width: 1800,
    height: 600,
    x: 2000,
    y: 2000,
  },
});
```

:::note
While you can create a BrowserView directly in bun it will only render when you add it to a window.
:::

## Constructor Options

### frame

Set the Webview's dimensions relative to the window. The default webview created via `new BrowserWindow()` will be stretched to cover the window's dimensions automatically.

```
const webview = new BrowserView({
   frame: {
    width: 1800,
    height: 600,
    x: 2000,
    y: 2000,
  },
});
```

### url

Set the initial url for the window's default BrowserView to navigate to when it opens.

```
// Use any url on the internet
const webview = new BrowserView({
   url: "https://electrobun.dev",
});

// or use the views:// url scheme to load local
// content that you've bundled with your app.

const webview = new BrowserView({
   url: "views://mainview/index.html",
});
```

### html

Set an html string for the window's default BrowserView to load when it opens. Anything that would be valid in an html file including javascript and css can be used.

Use this instead of setting the `url` property.

```
const htmlString = "<html><head></head><body><h1>hello world</h1></body></html>";

const webview = new BrowserView({
   html: htmlString,
});

```

### partition

Partitions allow you to separate the browser session. Things like cookies and so on. For example if you have two BrowserViews with the same partition and log into gmail in one, the other will also be logged into gmail. If you use two different partitions then you could log into a different gmail account in each BrowserView.

```
// ephemeral partition. If you close and reopen your app
// even if you use the same partition name it will not
// have persisted.
const webview = new BrowserView({
   partition: "partition1",
});

// To make partitions persistent just prefix it with `persist:`
const webview = new BrowserView({
   partition: "persist:partition1",
});
```

### preload

Set a preload script for the window's default BrowserView to render after html is parsed but before any other javascript is executed. The preload script will be run after any navigation before the page's scripts are run.

You can use either inline javascript or a url.

```
// Use any url on the internet
const webview = new BrowserView({
   preload: "https://electrobun.dev/some/remote/file.js",
});

// or use the views:// preload scheme to load local
// content that you've bundled with your app.

const webview = new BrowserView({
   preload: "views://somebundledview/preloadscript.js",
});

// or use inline javascript

const webview = new BrowserView({
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
import { BrowserView } from "electrobun/bun";
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
const webview = new BrowserView({
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
const answer = await webview.rpc.someWebviewFunction(4, 6);

// Send a message to the BrowserView from bun
webview.rpc.logToBrowser("my message");
```

:::info
The above code snippet shows defining the bun process rpc handlers and calling the browser process handlers from bun. To see how to handle the Browser context code take a look at the [Browser API](/docs/apis/browser/Electroview%20Class)
:::

### syncRpc

:::warning
The `SyncRpc` api is blocking. Calling `syncRpc` methods from the browser will completely block the browser thread and halt javascript while waiting for the bun process to respond.
:::

:::info
Really the only time you may want to use the `syncRpc` api instead of the regular async `rpc` api is when you're migrating from Electron to Electrobun and you had a lot of browser code with the node integration enabled. Using the `syncRpc` api can save you lots of time on the initial refactor/migration.

It's strongly advised to later follow up and migrate `syncRpc` methods to async `rpc` later on.
:::

```typescript title="src/bun/index.ts"
const win = new BrowserWindow({
  title: "my url window",
  url: "views://mainview/index.html",
  frame: {
    width: 1800,
    height: 600,
    x: 2000,
    y: 2000,
  },
  syncRpc: {
    someSyncBunMethod: ({ a, b }) => {
      console.log("doing sync math in bun", a, b);
      return a + b;
    },
  },
});
```

To see how to call syncRpc methods from the browser take a look at the [Browser API](/docs/apis/browser/Electroview%20Class)

## Static Methods

### BrowserView.getAll

Get a list of references to all BrowserViews. This includes the default Browserviews created via `new BrowserWindow`, Browserviews created as nested OOPIFs via [WebviewTags](/docs/apis/browser/Electrobun%20Webview%20Tag), and BrowserViews that you create manually via `new BrowserView()` for advanced use cases.

```typescript title="/src/bun/index.ts"
import { BrowserView } from "electrobun/bun";

const webviews = BrowserView.getAll();
```

### BrowserView.getById

Get a specific BrowserView by id. This includes the default Browserviews created via `new BrowserWindow`, Browserviews created as nested OOPIFs via [WebviewTags](/docs/apis/browser/Electrobun%20Webview%20Tag), and BrowserViews that you create manually via `new BrowserView()` for advanced use cases.

```typescript title="/src/bun/index.ts"
import { BrowserWindow, BrowserView } from "electrobun/bun";

const win = new BrowserWindow({
  title: "my url window",
  url: "views://mainview/index.html",
  frame: {
    width: 1800,
    height: 600,
    x: 2000,
    y: 2000,
  },
});

const webview = BrowserView.getById(win.webview.id);
```

### BrowserView.defineRPC

Whenever you create a BrowserWindow with async RPC you'll use this static method to create an RPC instance.

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
```

## Methods

### executeJavascript

Execute arbitrary js in the webview. Unlike a `preload` script that you would typically set as a [BrowserWindow](/docs/apis/bun/BrowserWindow) configuratino option, `executeJavascript()` can be called at any time.

```typescript title="/src/bun/index.ts"
webview.executeJavascript('document.body.innerHTML += "hello"');
```

### loadURL

Load a url into the webview. This will navigate the webview and trigger navigation events.

```typescript title="/src/bun/index.ts"
webview.loadURL("https://electrobun.dev");

// or

webview.loadURL("views://mainview/somepage.html");
```

### loadHTML

Load html directly into the webview. This will completely replace any content that was previously loaded and trigger navigation events.

```typescript title="/src/bun/index.ts"
const htmlString =
  "<html><head></head><body><h1>hello world</h1></body></html>";

webview.loadHTML({
  html: htmlString,
});
```

### on(name, handler)

Subscribe to BrowserWindow events (see below)

## Properties

### id

This is the webview's id.

### hostWebviewId

This is only used for BrowserViews created using the [WebviewTag](/docs/apis/browser/Electrobun%20Webview%20Tag) as a nested OOPIF. It's the id of the parent BrowserView.

### rpc

Once you've configured async rpc for a webview (typically via new BrowserWindow and Webview.defineRPC()) you'll use the rpc property to access the generated typed request and message methods.

```typescript title="/src/bun/index.ts"
// ... configure BrowserWindow with BrowserView.defineRPC and new BrowserWindow()

// Call a browser function from bun
const answer = await webview.rpc.someWebviewFunction(4, 6);

// Send a message to the BrowserView from bun
webview.rpc.logToBrowser("my message");
```

## Events

### will-navigate

When a webview is going to navigate. This is cancellable. Global events are fired first so you could cancel it globally, then on a specific Webview check if it was globally cancelled and reverse the decision.

```
event.data = {
    windowId: string,
    url: string,
    webviewId: string
}
```

```
Electrobun.events.on("will-navigate", (e) => {
  console.log(
    "example global will navigate handler",
    e.data.url,
    e.data.webviewId
  );


  e.response = { allow: false };
});

webview.on("will-navigate", (e) => {
  console.log(
    "example webview will navigate handler",
    e.data.url,
    e.data.webviewId
  );
  if (e.responseWasSet && e.response.allow === false) {
    e.response.allow = true;

    // Note: since allow is the default you could clear the
    // response instead which would also have the effect of
    // overriding the global decision
    // e.clearResponse();
  }
});
```

### did-navigate

After a webview navigates

```
event.data = {
    detail: string // the url
}
```

### did-navigate-in-page

After an in-page navigation

```
event.data = {
    detail: string // the url
}
```

### did-commit-navigation

The webview has started to receive content for the main frame after a navigation.

```
event.data = {
    detail: string // the url
}
```

### dom-ready

The the dom ready event is fired from the browser context.

### newWindowOpen

The browser context is attempting to open a new window. For example a popup or a user right clicked and selected "open in new window"
