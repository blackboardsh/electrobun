---
sidebar_position: 1
---

## Application Bundles

### MacOS

#### Your Installed App

On MacOS an application bundle is really just a folder with a .app file extension. The key subfolders inside are

```
// electrobun places several binaries here
/Contents/MacOS

// An optimized zig implementation of bspatch used to generate and apply diffs during updates
/Contents/MacOS/bspatch

// The bun runtime
/Contents/MacOS/bun

// An optimized zig binary that typically just calls `bun index.js` with the included runtime
// to run your compiled bun entrypoint file.
/Contents/MacOS/launcher

// A folder containing native code layer for the platform, on MacOS this these are
// objc binaries for interfacing with MacOS apis like NSWindow and WKWebkit
/Contents/MacOS/native/

// electrobun compiles your application's custom code here
/Contents/MacOS/Resources

// Your application icons
/Contents/MacOS/Resources/AppIcon.icns

// Local version info that `Electrobun.Updater` reads
/Contents/MacOS/Resources/version.json

// Folder containing the bundled javascript code for the main bun process.
// Use electrobun.config to tell Electrobun where your ts entrypoing is and
// define external dependencies
/Contents/MacOS/Resources/app/bun/

// This is where your views defined in electrobun.config are transpiled to
// Browserviews can also use the views:// url schema anywhere urls are loaded
// to load bundled static content from here.
/Contents/MacOS/Resources/app/views
```

#### IPC

In order to communicate between bun, zig, and browser contexts Electrobun has several mechanisms for establishing IPC between the processes involved. For the most part Electrobun uses efficient named pipes and serializes json rpc over the pipes.

#### Self-Extracting Bundle

Because zip file compression is not the best and we want apps you build with Electrobun to be as tiny as possible Electron automatically bundles your application into a self-extracting bundle. Electrobun takes your entire app bundle, tars it, compresses it with zlib which is fast best-in-class modern compression and creates a second app bundle for distribution.

:::info
The current Electrobun Playground app is **50.4MB** in size (most of this is the bun runtime), but when compressed and distributed as the self-extracting bundle it's only **13.1MB which is almost 5 times smaller**.

_Meaning almost 5 times as many users can download your app for the same cost in Storage and Network fees._
:::

The self-extracting bundle looks like this:

```
// This is different from the regular launcher binary. It's a zig binary that uses zlip to decompress your actual app bundle
/Contents/MacOS/launcher

// App icons are actually stored again so the self-extractor looks just like your extracted bundled app.
/Contents/Resources/AppIcons.icns

// Your actual app bundled, tarred, and compressed with the name set to the hash
/Contents/Resources/23fajlkj2.tar.zst
```

A user can install the self-extracting bundle the same as any other application in the `/Applications/` folder or run it from any folder on your machine. When your end-user double clicks to open it, it will transparently self-extract and replace itself with your full application and then launch the full application. To your user it just looks like the first time opening your app takes 1 or 2 seconds longer.

The self-extraction process only happens on first install and is entirely local and self-contained using only a designated application support folder for your app for the extraction and verification.

#### DMG

Finally electrobun will automatically generate a DMG with the self-extracting bundle inside.

## Code Signing and Notarization

Electrobun will automatically code sign and notarize your application for you.

### MacOS

There is a prerequesite to register for an Apple Developer account and create an app id as well as download your code signing certificate. We'll have a guide that walks you through this process. There is no need to have any private keys in your code repo but you do need to set `codesigning` and `notarization` flags to `true` in your `electrobun.config` file and make some credentials available in your env.

On MacOS Electrobun will code sign and notarize both your app bundle **and** the self-extracting bundle so your end-users can be confident that what their installing is legitimately from you and has been scanned by Apple.

While code signing is generally very fast, notarization requires uploading a zip file to Apple's servers and waiting for them to scan and verify your app's code which typically takes about 1-2 minutes. The notarization is then stapled to your app bundle.

Because notarization can take time, in cases where a bug only exists on non-dev builds you can simply turn off code signing and/or notarization in your `electrobun.config` while debugging to speed up the build process.

Any notarization issues will be shown to you in the terminal so you can address them. This typically involves setting certain entitlements for your application so that your app declares what it uses to Apple and your end-users.

## Updating

Electrobun has a [built-in update mechanism](/docs/apis/bun/Updater) that optimizes updates for file-size and efficiency.

:::info
Ship updates to your users as small as 14KB. This lets your ship often without paying huge storage and network fees.

No server required, all you need is a static file host like S3 which you can put behind a CDN like Cloudfront. Most apps will fall well within AWS's free tier even if you ship updates often to many users.
:::

### How does it work

Using the [Electrobun Updater api](/docs/apis/bun/Updater) you can check for updates and automatically download, and install them. The flow looks something like:

1. Check the local version.json hash against the hosted update.json hash of the latest version.
2. If it's different download the tiny patch file that matches the hash you have (generated with BSDIFF) and apply it to the current bundle.
3. Generate a hash of the patched bundle. If it matches the latest hash then replace the running application with the latest version of the app and relaunch (you can control when with the api and let the user trigger this manually when they're ready)
4. If the hash does not match the latest look for another patch file and keep patching until it does.
5. If for some reason the algorithm can't patch its way to the latest version it will download a zlib compressed bundle from your static host and complete the update that way.

:::info
Whenever you build a non-dev build of your app the electrobun cli will automatically generate a patch from the current hosted version to the newly built version.

It's completely up to you how many patches you make available on your static host.
:::

## CLI and development builds

The Electrobun cli is automatically installed locally to your project when you `bun install electrobun`. You can then add npm scripts and an `electrobun.config` file to build your app.

### Development Builds

When building a `dev` build of your app instead of the optimized `launcher` binary the cli uses a special dev launcher binary which routes any bun, zig, and native output to your terminal.

Dev builds are not meant to be distributed and so the cli does not generate artifacts for dev builds.

### Distribution

Whne building `canary` and `stable` builds of your app Electrobun will generate an `artifacts` folder that contains everything you need to upload to a static host for distribution and updates.
