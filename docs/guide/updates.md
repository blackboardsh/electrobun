---
title: "Updates"
---

## Introduction
We've implemented a batteries included update mechanism. All you need is to bring your own static file host like AWS S3, Cloudflare R2, or GitHub Releases.

- [Update API](/api/updater) to check for, download, and update your apps.

- [CLI](/api/cli-args) to build your app bundle, codesign, and generate artifacts.

- A custom BSDIFF implementation in zig that takes advantage of SIMD operations for performance and lets you distribute updates as small as 14KB

## Hosting on GitHub Releases
GitHub Releases is a convenient option for hosting your update artifacts, especially for open source projects. Electrobun uses a flat, prefix-based naming scheme (e.g., `stable-macos-arm64-update.json`) that works with hosts that don't support folder structures.

### Configuration
Set your `baseUrl` in `electrobun.config` to point to your GitHub Releases:

```ts
// electrobun.config.ts
export default {
  // ...
  release: {
    baseUrl: "https://github.com/YOUR_ORG/YOUR_REPO/releases/latest/download",
  },
};

```

### Example GitHub Action
Here's an example workflow that builds and publishes releases when you push a tag:

```yaml
name: Build and Release

on:
  push:
    tags:
      - 'v*'

jobs:
  build-macos-arm64:
    runs-on: macos-14  # Apple Silicon runner

    steps:
      - name: Checkout code
uses: actions/checkout@v4

      - name: Setup Bun
uses: oven-sh/setup-bun@v2
with:
bun-version: latest

      - name: Install dependencies
run: bun install

      - name: Determine build environment
id: build-env
run: |
if [[ "${{ github.ref_name }}" == *"-canary"* ]]; then
echo "env=canary" >> $GITHUB_OUTPUT
else
echo "env=stable" >> $GITHUB_OUTPUT
fi

      - name: Build app
env:
ELECTROBUN_DEVELOPER_ID: ${{ secrets.ELECTROBUN_DEVELOPER_ID }}
APPLE_ID: ${{ secrets.APPLE_ID }}
APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
run: |
if [ "${{ steps.build-env.outputs.env }}" = "canary" ]; then
bun run build:canary
else
bun run build:stable
fi

      - name: Create Release
uses: softprops/action-gh-release@v1
with:
files: artifacts/*
draft: false
prerelease: ${{ steps.build-env.outputs.env == 'canary' }}
generate_release_notes: true
env:
GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

```

The `generate_release_notes: true` option uses GitHub's automatic release notes feature, which lists merged PRs and contributors since the last release.

## Limitations

### Single Patch File
Electrobun only generates a single patch file per build - from the immediately previous version to the current version. This means:

- Users updating from the previous version get a small delta patch (often just a few KB)

- Users more than one version behind will automatically fall back to downloading the full `.tar.zst` bundle
This is a practical tradeoff that keeps the build process simple while still providing delta updates for users who update regularly.

### Canary Builds on GitHub Releases
GitHub's `/releases/latest/download` URL only resolves to non-prerelease builds. This means:

- **Stable builds**: Auto-updates work correctly via `/releases/latest/download`

- **Canary builds**: Will not auto-update when hosted on GitHub Releases because the `latest` URL won't point to prerelease versions
If you need auto-updating canary builds, consider using a static file host like Cloudflare R2 or AWS S3 where you control the URL structure directly.