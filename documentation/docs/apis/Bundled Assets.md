## Bundling Static Assets in your app

The `views://` schema in Electrobun provides a robust method for handling static assets, ensuring they are securely and efficiently managed within the application's bundle. This documentation explains how to use this schema to set URLs for new `BrowserWindow` instances, incorporate CSS and JavaScript into HTML, and bundle static assets via the `electrobun.config`.

### Overview of `views://` Schema

The `views://` schema is a custom protocol used in Electrobun to reference assets and files within the application bundle. This schema allows for a clean separation of application logic and resources, ensuring that static assets like HTML, CSS, and JavaScript files are encapsulated within specified views or components.

You can think of the `views://` schema as an alternative to `https://` so it can be used in the context of BrowserViews anywhere a normal url can be used and electrobun will securely map those paths to the static asset folder in your application bundle.

### Using `views://` in BrowserWindow URLs

You can use the `views://` schema to set the URL for a new `BrowserWindow()` in Electrobun. This method simplifies referencing bundled assets and enhances security by encapsulating resources.

#### Example Usage

```javascript
const { BrowserWindow } = require("electrobun");

const mainWindow = new BrowserWindow({
  width: 800,
  height: 600,
  title: "Main Window",
});

mainWindow.loadURL("views://mainview/index.html");
```

In this example, `mainWindow` loads an HTML file located at `views://mainview/index.html`. This URL points to the `index.html` file within the `mainview` directory defined in the `electrobun.config`.

### Incorporating CSS and JavaScript

Using the `views://` schema, CSS and JavaScript files can be loaded directly within an HTML file bundled in the application.

#### HTML Example

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Sample Page</title>
    <link rel="stylesheet" href="views://mainview/style.css" />
    <script src="views://mainview/script.js"></script>
    <style>
      div {
        background: url(views://mainview/somebg.png);
      }
    </style>
  </head>
  <body>
    <h1>Welcome to Electrobun</h1>
  </body>
</html>
```

Here, `style.css` and `script.js` are loaded using the `views://` schema, pointing directly to the assets within the `mainview` directory.

You can also see a `views://` url used directly in css just like you'd use any `https://` url.

### Bundling Static Assets via `electrobun.config`

The `electrobun.config` file can be configured to bundle and manage static assets using the `views://` schema. This configuration ensures all necessary assets are included during the build process and correctly referenced within the application.

:::info
The property name for each view, in this case `mainview` can be anything you'd like. And you can specify as many views as you'd like. This maps directly to the path you would use when referencing a file so you can organize your assets.
:::

#### Configuration Example

```json
"build": {
    "views": {
        "mainview": {
            "entrypoint": "src/mainview/index.ts",
            "external": []
        }
    },
    "copy": {
        "src/mainview/index.html": "views/mainview/index.html",
        "src/mainview/style.css": "views/mainview/style.css",
        "src/mainview/script.js": "views/mainview/script.js"
    }
}
```

:::note
Notice that in the "copy" section the destination is `views/mainview/` which maps to the url `views://mainview/`.
:::

In the `electrobun.config`, the `views` section defines entry points for scripts, while the `copy` section specifies static assets like HTML, CSS, and JavaScript files to be copied to their respective directories in the build output.

### Summary

The `views://` schema in Electrobun provides a structured and secure way to manage and reference static assets within your applications. By configuring the `electrobun.config` appropriately and using the schema within your application code, you can ensure a clean, organized, and encapsulated asset management system.
