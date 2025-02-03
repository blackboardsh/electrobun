---
sidebar_position: 1
---

> Instantiate Electrobun apis in the browser.

```
import {Electroview} from "electrobun/view";

const electrobun = new Electroview({ ...options })

```

## Constructor Options

### rpc

This is the browser side of creating typed RPC between the main bun process and a given BrowserView's context.

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

```typescript title="/src/myview/index.ts"
import { Electroview } from "electrobun/view";
import { type MyWebviewRPCType } from "../shared/types";

const rpc = Electroview.defineRPC<MyWebviewRPC>({
  handlers: {
    requests: {
      someWebviewFunction: ({ a, b }) => {
        document.body.innerHTML += `bun asked me to do math with ${a} and ${b}\n`;
        return a + b;
      },
    },
    messages: {
      logToWebview: ({ msg }) => {
        // this will appear in the inspect element devtools console
        console.log(`bun asked me to logToWebview: ${msg}`);
      },
    },
  },
});
const electroview = new ElectrobunView.Electroview({ rpc });
```

Assuming you've wired up rpc on the bun side when creating the [BrowserWindow](/docs/apis/bun/BrowserWindow) you'll be able to call those bun functions from the browser.

```typescript title="/src/myview/index.ts"
electroview.rpc.request.someBunFunction({ a: 9, b: 8 }).then((result) => {
  console.log("result: ", result);
});

// or
electroview.rpc.send.logToBun({ msg: "hi from browser" });
```

## Static Methods

### defineRPC

Pass `Electroview.defineRPC` the shared rpc type to generate the typed rpc and message functions you can call from the browser and to set up types for the browser handlers for functions handled in the browser.

## Methods


### Browser to Browser RPC

Electrobun doesn't provide browser to browser RPC out of the box as we favour isolation between browser contexts for greater security.

There's nothing stopping you from creating bun to browser rpc for two different BrowserViews and passing messages between them via bun. You can also establish any number of other web-based mechanisms to communicated between browser contexts from localstorage to webRTC or via a server.
