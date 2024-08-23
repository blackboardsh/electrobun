## Electrobun Configuration (`electrobun.config`)

This document provides detailed descriptions of the `electrobun.config` file, outlining how to configure your Electrobun application's build, deployment, and operational settings. This file tells the Electrobun CLI how to build and configure your app.

```javascript
{
    // This section sets the core application metadata.
    "app": {
        // Your application name, spaces and some special characters are allowed.
        // Your App distributables will use this and it's the name displayed in the
        // Mac application menu when your app is focused.
        "name": "Electrobun (Playground)",
        // A unique identifier for the application, typically using reverse domain name
        // notation. This should match the identifier for this app in your Apple Developer
        // account
        "identifier": "dev.electrobun.playground",
        // The version of your app
        "version": "0.0.1"
    },
    // Defines the settings and paths for the application's build process.
    "build": {
        // Configure the `bun build <entrypoint>` command that gets run
        // to build the main bun process
        "bun": {
            // entrypoint should point to your typescript entrypoint for
            // the main bun process
            "entrypoint": "src/bun/index.ts",
            // List any dependencies that should be treated as external
            "external": []
        },
        // Configure the `bun build <entrypoint>` command that gets
        // run to transpile typescript for the browser.
        "views": {
            // you can use any folder-safe name "mainview"
            // will transpile the entrypoint into /Resources/app/views/mainview/index.js
            // in the MacOS bundle
            "mainview": {
                "entrypoint": "src/mainview/index.ts",
                "external": []
            },
            "myextension": {
                "entrypoint": "src/myextension/preload.ts",
                "external": []
            }
        },
        // Copy files or folders from your src repo into the bundle. On MacOS
        // the to paths are relative to the Resources/app/ folder. While the main
        // bun process can access resources anywhere in the bundle BrowserViews
        "copy": {
            // can use the views:// scheme urls to load bundled resources.
            // the views://mainview/index.html url maps to the views/mainview/index.html
            "src/mainview/index.html": "views/mainview/index.html",
            // It's useful to group your source code and bundled files by the name
            // of the view they're for but that's not necessary, you can organize
            // them however you like.
            "src/mainview/index.css": "views/mainview/index.css"
        },
        // Mac specific configuration
        "mac": {
            // Fill a folder with different sized pngs that will be used as your App's icon.
            // (https://developer.apple.com/documentation/xcode/configuring-your-app-icon)
            // You can use a single 1024x1024 image or multiple images at different sizes. Name the folder icon.iconset and specify the path here.
            "icons": "icon.iconset",
            // Toggle code signing and notarization for non-dev builds on and off
            "codesign": true,
            "notarize": true,
            // Specify a list of entitlements.

            "entitlements": {
                // The "com.apple.security.cs.allow-jit": true is enabled by default
                // as it's required for hardened runtime macos applications, which is
                // required for notarization.
                // https://developer.apple.com/documentation/bundleresources/entitlements

                // You will likely also have to enable some entitlements in your
                // Apple Developer account for the corresponding app.
            }
        }
    }
    // Script hooks to run custom code during the build process. These are Typescript
    // files executed with the bun runtime.
    "scripts": {
        // postBuild is executed after the mac app bundle is created, but before codeSigning.
        // A good time to run tailwind, copy extra assets into the bundle, or other
        // custom build steps.
        "postBuild": "./buildScript.ts"
    },
    "release": {
        // The only thing you need for updates to work is a static file host like S3.
        // Specify the main bucket url. Electrobun will append the channel name internally
        // to find the files it needs for updating. When building non-dev channels
        // like canary and stable Electrobun will generate an artifacts folder
        // with subfolders for each channel that you can upload direcly to the bucketUrl
        "bucketUrl": "https://storage.googleapis.com/somebucket/bucket-subfolder/"
    }
}
```
