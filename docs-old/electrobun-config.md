## Electrobun config

This file tells the Electrobun cli how to build and configure your app.

```javascript
{
    "build": {
        "bun": {
            "entrypoint": "src/bun/index.ts",
            "external": []
        },
        "views": {
            "mainview": {
                "entrypoint": "src/mainview/index.ts",
                "external": []
            },
            "myextension": {
                "entrypoint": "src/myextension/preload.ts",
                "external": []
            }
        },
        "copy": {
            "src/mainview/index.html": "views/mainview/index.html",
            "src/mainview/index.css": "views/mainview/index.css"
        }
    }
}
```

### "bun"

The build.bun section is where you describe the entrypoint to your 'main' process. It expects bun typescript file, you can specify which dependencies are external. This is basically like calling Bun build with 'bun' target.

### "copy"

The copy section is straightforward. It's executed after the "views" section, and will plainly copy files into the build directory. The destinations are relative paths in the build directory. In this example we knkow that `build/mainview` will be created because we have defined a `mainview` key in the views section.

### "views":

Here you define views. The electrobun cli will use `bun build` with 'browser' target to bundle each entrypoint. The names of the keys here `mainview` and `myextension` can be anything you want and you can have as many views as you want. The names (keys) used here become folder names in your built apps. The filename of the entrypoint, in this case `index.ts` and `preload.ts` are preserved and become `index.js` and `preload.js` in their respective views folder. The zig process will expose views to webviews via the `views://` scheme. This can be used either in the url property when creating a new `BrowserWindow` or `BrowserView` or within any custom html or remotely loaded html. There is (or soon will be) an option to enable/disable exposing custom `views://` scheme to the webview. While a webview can't "escape" the views folder exposed by the custom scheme, you may not want certain webviews -- especially when loading remote content you don't control, from trying to load arbitrary files from your build/views directory. There are other use cases where you may actually want exactly that

So for example you could open a browser window with

```javascript
const win = new BrowserWindow({
  title: "my url window",
  url: "views://mainview/index.html",
  frame: {
    width: 1800,
    height: 600,
    x: 2000,
    y: 2000,
  },
  rpc: myWebviewRPC,
});
```

and the content of that index.html can be

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
    <h1>hi World</h1>
  </body>
</html>
```
