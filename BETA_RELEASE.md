# Electrobun release channels

Every Electrobun release has one exact version and one `v<version>` tag. Its
core and optional CEF archives plus `electrobun-artifacts.json`, four mirrored
paired-Hutch archives plus `hutch-artifacts.json`, single dependency-free npm
bootstrap, Kitchen release fixture, and template catalog metadata move together.

Updater packaging is a cross-repository contract. When an Electrobun release
depends on Hutch metadata or artifact-layout changes, publish Hutch first and
update the exact `// @hutch` pin in `package/hutch.config.ts`. The final release
check must run against that pinned Hutch release. A sibling Hutch checkout is a
development override only and must be selected explicitly with
`ELECTROBUN_UPDATER_E2E_HUTCH` (and `HUTCH_ENGINE_BINARY` when needed).

From a clean `main` checkout, run the release task in `package`:

```sh
hutch push:beta
```

The updater lifecycle is intentionally a local desktop-VM test and does not run
as part of `check:release`, the `push:*` tasks, or release CI. When working on
installer, updater, or uninstaller code, run `hutch test:updater-lifecycle` from
`package/`. It builds four releases, installs the first, verifies an app two
versions behind follows a two-patch chain, verifies the next update falls back
to the full archive when its patch returns `404`, and then uninstalls. It uses
real native UI and may display installer or uninstaller windows while running.

Before the first 2.0 release, also smoke-test one real v1.18.1 installation
updating to the 2.0 release candidate. Keep `app.name`, `app.identifier`, and
the release base URL unchanged for that bridge release, and verify that the
updated app preserves its data/profile root and can update and uninstall again.

The task runs the release checks, advances the version with npm's prerelease
semantics, updates every synchronized identity, commits `v<version>`, creates
that tag, and pushes it. For example, a beta bump from `2.0.0` produces
`v2.0.1-beta.0`.

The single release workflow then:

1. builds the per-platform core archives and Kitchen artifacts;
2. downloads and verifies the four archives from the independently published,
   exactly paired Hutch release, mirrors them into the Electrobun release, and
   creates `electrobun-artifacts.json` and `hutch-artifacts.json`; every indexed
   archive is bound to its immutable GitHub Release URL, byte size, and SHA-256
   digest before the draft release is verified and finalized;
3. tests and publishes the single dependency-free `npm/electrobun` package with
   npm's `beta` dist-tag;
4. on macOS arm64, Linux x64/arm64, and Windows x64, upgrades an isolated real
   v1.18.1 npm project to the exact public release, verifies the one-package
   layout, downloads its paired Hutch from that version's public GitHub
   Release, and proves the warm cache works offline; and
5. only after that acceptance matrix passes, publishes the Kitchen artifacts
   to R2, stamps the exact release version into each staged template's
   `hutch.config.ts`, and then advances the matching beta template catalog.

Stable tags use the same path and publish the npm package under `latest` plus
the stable template catalog. The npm package remains only a small command that
downloads, verifies, caches, and invokes its paired Hutch archive from the
Electrobun GitHub Release; it contains no Electrobun runtime or SDK and has no
platform-specific npm packages.

Installing the npm beta still does not implicitly select beta templates:

```sh
npx electrobun init          # stable templates
npx electrobun init --beta   # beta templates
```
