---
sidebar_position: 4
title: Distributing
sidebar_label: 4. Distributing
slug: /guides/distributing
---

:::info
Continuing on from the [Creating UI](/docs/guides/creating-ui) Guide.
:::

Let's add two more scripts to our `package.json` file to get our app ready for distribution. `build:canary` and `build:stable`:

```json title="package.json
{
  "name": "my-app",
  "devDependencies": {
    "@types/bun": "latest"
  },
  "peerDependencies": {
    "typescript": "^5.0.0"
  },
  "dependencies": {
    "electrobun": "^0.0.1"
  },
  "scripts": {
    "start": "bun run build:dev && electrobun dev",
    "build:dev": "bun install && electrobun build",
    "build:canary": "electrobun build env=canary",
    "build:stable": "electrobun build env=stable"
  }
}
```

In your terminal you can now run

```
bun run build:canary

// or

bun run build:stable
```

Both of these non-dev builds will:

- build an optimized MacOS app bundle
- tar and compress it using state of the art compression
- generate another self-extracting app bundle
- create an `artifacts` folder for distribution

:::info
All you need to distribute your app is a static file host like S3 or Google Cloud Storage. There's no need to run a server beyond that.
:::

Let's assume you've set up a Google Cloud Storage bucket with a subfolder for this application and add it to `electrobun.config.ts`:

```typescript title="electrobun.config.ts"
export default {
  app: {
    name: "My App",
    identifier: "dev.my.app",
    version: "0.0.1",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      "main-ui": {
        entrypoint: "src/main-ui/index.ts",
      },
    },
    copy: {
      "src/main-ui/index.html": "views/main-ui/index.html",
    },
  },
  release: {
    bucketUrl: "https://storage.googleapis.com/mybucketname/myapp/",
  },
};
```

You can make your app available by simply uploading the contents of the `artifacts` folder into the `myapp` folder of your bucket. The artifacts folder will have two subfolders, one for `canary` and one for `stable`.

Once you've uploaded the artifacts to your bucket when your run a non-dev build command again like `bun run build:canary` the Electrobun cli will automatically download the current version of your app, use our custom optimize BSDIFF implementation to generate a patch file and add the patch file to your artifacts folder.

Visit the [Updater API docs](/docs/apis/bun/Updater) to learn how to make your app check for and install updates.

### What are all the files in the artifacts folder

```
// Assuming your app's name is MyApp and you did a canary build you'll have the following files:

// This file contains metadata for the version of your app you just built
/artifacts/canary/update.json

// This is the file you would link to on your marketing site for users to download
// when first installing your app. It's a dmg that contains your app in its
// self-extracting form
/artifacts/canary/MyApp-canary.dmg

// This is a copy of the compressed tar file of your app bundle. There's a copy
// of this inside the self-extracting bundle. When your app updates itself if there
// are no patch files available it will download this to update your app.
/artifacts/canary/MyApp-canary.app.tar.zst

// These files are named <hash>.patch. The Electrobun cli generates patch files
// from the current version on your static cloud hosting to the version your just
// built.

// When replacing the contents of your static file host you can keep as many old
// patch files as you like. Users with older versions of your app will keep downloading
// the next patch automatically when updating.
/artifacts/canary/jsf87yasf.patch

```
