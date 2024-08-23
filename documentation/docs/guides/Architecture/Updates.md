## Introduction

We've implemented a batteries included update mechanism. All you need is to bring your own static file host like S3.

- [Update API](/docs/apis/bun/Updater) to check for, download, and update your apps.
- [CLI](/docs/apis/cli/cli%20args) to build your app bundle, codesign, and generate artifacts.
- A custom BSDIFF implementation in zig that lets you distribute updates as small as 14KB
