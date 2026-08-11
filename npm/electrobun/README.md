# Electrobun npm bootstrap

The `electrobun` npm package is a small compatibility entry point for npm,
pnpm, Yarn, and Bun users. It contains no Electrobun runtime or SDK. The
`electrobun` command installs Hutch into `~/.dash` when necessary and delegates
all commands to `hutch electrobun`.

Create a project from the current stable template catalog:

```sh
npx electrobun init
```

Use the beta catalog only when you ask for it:

```sh
npx electrobun init --beta
```

The npm package version describes this bootstrap, not the Electrobun runtime.
An application's exact Electrobun version is selected in
`hutch.config.ts`; Hutch downloads the matching runtime and SDK into the shared
`~/.dash` store and copies the SDKs into the project's `.hutch/devkit` sysroot.

`DASH_RELEASE_OFFLINE=1` prevents this bootstrap from downloading a missing
Hutch installation. An already installed Hutch is still invoked, and the flag
continues to prevent network access for Dash-managed releases and artifacts.
It does not put npm or another project package manager into offline mode.

You can install Hutch directly from <https://hutch.blackboard.sh> and run the
same commands without npm:

```sh
hutch electrobun init
```
