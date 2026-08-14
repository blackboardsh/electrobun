# Electrobun release channels

Every Electrobun release has one exact version and one `v<version>` tag. The
release manifest, thin npm bootstrap, Kitchen release fixture, and template
release pins move together.

From a clean `main` checkout, run the release task in `package`:

```sh
hutch push:beta
```

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
