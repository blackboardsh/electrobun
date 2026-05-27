---
title: "Updater"
---

# Updater

Electrobun's built-in update mechanism for your app

```ts
// /src/bun/index.ts

```

```ts
// /electrobun.config
{
 ...

 "release": {
    "baseUrl": "https://your-release-url"
 }
}

```

## Updating Electrobun Apps

Electrobun ships with a built-in update mechanism that lets you ship updates to your app as small as 14KB so you can ship often. All you need to do is specify a url where your artifacts are stored in your `electrobun.config` file. A static file host like AWS S3 + Cloudfront, Cloudflare R2, or even GitHub Releases is more than enough, most likely your app will stay well within the free tier.The electrobun `cli` will automatically generate a flat `artifacts` folder for each non-dev build (typically `canary` and `stable`). Just upload the files to your host and set the `baseUrl`, then use the API to check for and install updates when your app launches, on an interval, or in response to a system tray menu item.

## Methods

### getLocalInfo

Get the local version info for display in your app or other logic. This will read the `version.json` file bundled with your app.

```yaml
const localInfo = await Electrobun.Updater.getLocalInfo();

localInfo: {
  version: string;
  hash: string;
  baseUrl: string;
  channel: string;
  name: string;
  identifier: string;
};

```

### checkForUpdate

Checks for an update by fetching the `update.json` file from the `baseUrl` for the current channel and platform.

```ts
const updateInfo = await Electrobun.Updater.checkForUpdate();

updateInfo: {
  version: string;
  hash: string;
  updateAvailable: boolean;
  updateReady: boolean;
  error: string;
};

```

### downloadUpdate

This will initiate a process where it attempts to download patch files and apply them until the patched app matches the current version. If something goes wrong like there isn't a trail of patch files from the user's version to current it will download the latest full version of the app directly.

```ts
await Electrobun.Updater.downloadUpdate();

```

### applyUpdate

Once the latest version is either patched or downloaded and ready to install you can call `applyUpdate` to quit the current app, replace it with the latest version, and relaunch.

```ts
if (Electrobun.Updater.updateInfo()?.updateReady) {
  await Electrobun.Updater.applyUpdate();
}

```
