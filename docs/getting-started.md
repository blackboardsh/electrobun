## How do create an Electrobun app as a developer.

> Note: Electrobun is not yet available on npm so check out the /example app which uses a file:// dependency reference, once it's on npm you'll add it as a normal dependency.

1. add electrobun to your package.json as a dependency
2. add an npm script `"build:dev: "electrobun build"`
3. add another `start: "electrobun dev`
4. in your terminal run `bun build:dev && bun start`

### Open a remote window

```javascript
// src/bun/index.ts
// this is your main process
import { BrowserWindow } from "electrobun/bun";

const win = new BrowserWindow({
  title: "my url window",
  url: "https://electrobun.dev", // any url here
  frame: {
    width: 1800,
    height: 600,
    x: 2000,
    y: 2000,
  },
});
```

```javascript
// src/electrobun.config
// this is where you tell electrobun cli about your main process code
{
    "build": {
        "bun": {
            "entrypoint": "src/bun/index.ts",
            "external": []
        },
    }
}
```

### Create a full application

Look at the code in the /example project to see how to:

1. configure bundling multiple views
2. import and use the Electrobun browser api
3. open a window to a local view url, and load local html, js, and css with the `views://` schema
4. create type safe RPC between bun and specific webviews
5. listen to events like 'will-navigate' and allow/block navigation based on url
6. run and debug your app
