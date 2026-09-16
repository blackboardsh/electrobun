# Electrobun npm bootstrap

The dependency-free `electrobun` npm package is a small Hutch entry point for
npm, pnpm, Yarn, and Bun users. It contains no Electrobun runtime, SDK, or
platform-specific npm dependency. On first use, the `electrobun` command reads
the `hutch-artifacts.json` index for its exact version, downloads the host's
matching Hutch archive from the indexed immutable Electrobun GitHub Release
URL, checks its byte length and SHA-256 digest against that index entry, caches
the extracted launcher and engine safely, and delegates all commands to `hutch
electrobun`. `electrobun init` additionally ensures a compatible global
Hutch launcher is present for the generated project's `hutch run ...` tasks;
init itself still runs through the exact private cache.

Create a project from the current stable template catalog:

```sh
npx electrobun init
```

Use the beta catalog only when you ask for it:

```sh
npx electrobun init --beta
```

The npm bootstrap supplies the exact Hutch and Electrobun defaults paired with
its own release version. Those defaults are not overrides: published templates
include an exact `electrobun.version`, and an exact `// @hutch` pragma or
product pin in `hutch.config.ts` always wins. In an unpinned hand-written
project, the installed package version selects the toolchain for npm-launched
commands, so the single `electrobun` dependency and its immutable GitHub Release
assets ride the project lockfile together. Hutch
downloads the matching runtime and SDK into the shared
`~/.hutch/releases/electrobun` store and projects the SDKs into the project's
`.hutch/devkit` sysroot. Hutch's paired Cottontail is the build-time runtime;
the Cottontail bundled into an app is separately pinned by that resolved
Electrobun devkit. Installing a beta bootstrap still uses stable templates
unless `init` receives `--beta`.

`DASH_RELEASE_OFFLINE=1` prevents this bootstrap from downloading a missing
Hutch archive. A previously verified cached copy can still run, but
`electrobun init` requires network access for the current template catalog and
selected template. Builds can run without network access only when every exact
release and managed toolchain they require is already installed. The flag does
not put Hutch's built-in dependency resolver or an external project package
manager into offline mode.

You can install Hutch directly from <https://hutch.blackboard.sh> and run the
same commands without npm:

```sh
hutch electrobun init
```
