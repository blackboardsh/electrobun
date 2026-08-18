# Electrobun release channels

Every Electrobun release has one exact version and one `v<version>` tag. The
release manifest, thin npm bootstrap, Kitchen release fixture, and template
release pins move together.

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

To exercise install, update, relaunch, and uninstall directly on the current
native platform before the release task, run `hutch test:updater-lifecycle`
from `package/`. The shared lifecycle builds four releases, verifies an app two
versions behind follows a two-patch chain, verifies the next update falls back
to the full archive when its patch returns `404`, and then uninstalls.

Before the first 2.0 release, also smoke-test one real v1.18.1 installation
updating to the 2.0 release candidate. Keep `app.name`, `app.identifier`, and
the release base URL unchanged for that bridge release, and verify that the
updated app preserves its data/profile root and can update and uninstall again.

The task runs the release checks, advances the version with npm's prerelease
semantics, updates every synchronized identity, commits `v<version>`, creates
that tag, and pushes it. For example, a beta bump from `2.0.0` produces
`v2.0.1-beta.0`.

The single release workflow then:

1. builds the per-platform core archives containing the runtime and SDK/devkit;
2. publishes Kitchen builds and the GitHub prerelease;
3. tests and publishes `npm/electrobun` with npm's `beta` dist-tag;
4. publishes the matching beta template catalog.

Stable tags use the same path and publish the npm package under `latest` plus
the stable template catalog. The npm package remains only a small command that
installs and invokes Hutch; it contains no Electrobun runtime or SDK.

Installing the npm beta still does not implicitly select beta templates:

```sh
npx electrobun init          # stable templates
npx electrobun init --beta   # beta templates
```
