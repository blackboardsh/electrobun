> Electrobun's built-in update mechanism for your app

```typescript title="/src/bun/index.ts"
import { Updator } from "electrobun/bun";
```

```json title="/electrobun.config"
{
 ...

 "release": {
    "bucketUrl": "https://s3-url"
 }
}
```

## Updating Electrobun Apps

Electrobun ships with a built-in update mechanism that lets you ship updates to your app as small as 14KB so you can ship often. All you need to do is specify a url where your artifacts are stored in your `electrobun.config` file. A static file host like S3 + cloudfront is more than enough, most likely your app will stay well within the free tier.

The electrobun `cli` will automatically generate an `artifacts` folder for each non-dev build (typically `canary` and `stable`), just upload those folders to S3 and set the bucketUrl, then use the api to check for and install updates when your app launches and on an interval or in response to a system tray menu to check for updates whenever a user initiates it.

## Methods

### getLocalInfo

Get the local version info for display in your app or other logic. This will read the `version.json` file bundled with your app.

```
const localInfo = await Electrobun.Updator.getLocal;

localInfo: {
  version: string;
  hash: string;
  bucketUrl: string;
  channel: string;
  name: string;
  identifier: string;
};
```

### checkForUpdate

Checks for an update by reading the update.json file at the url specified in the s3 subfolder for the current channel.

```
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

```
await Electrobun.Updater.downloadUpdate();
```

### applyUpdate

Once the latest version is either patched or downloaded and ready to install you can call `applyUpdate` to quit the current app, replace it with the latest version, and relaunch.

```
if (Electrobun.Updater.updateInfo()?.updateReady) {
  await Electrobun.Updater.applyUpdate();
}
```
