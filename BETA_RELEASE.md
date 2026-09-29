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

For a complete pre-release pass on each desktop VM, run this from `package`:

```sh
hutch test:vm
```

It builds the package and every Kitchen main-process backend (Cottontail, Bun,
Zig, Rust, Go, Odin) against both the system webview (without bundled CEF) and
CEF, then runs each variant's automated suite one at a time. It then runs
`test:unit` (unit tests plus the desktop-only native tests), Kitchen's
`test:tooling`, the complete install/update/uninstall lifecycle, and finally
`check:release`. Every stage
runs even if an earlier stage fails (Kitchen launches are skipped, and
reported, only when the build stage failed, so stale builds are never tested);
the task prints a combined failure summary and exits nonzero at the end.

Each Kitchen launch runs under a watchdog (`--timeout`): an app that deadlocks
or never finishes is killed with its CEF helpers and reported as a failed stage
instead of hanging the VM run.

Kitchen tests declare hard renderer requirements explicitly. A requested
`renderer: "cef"` is not itself a requirement: renderer-neutral tests preserve
that request so system-only builds exercise Electrobun's CEF-to-system fallback.
Only tests whose stated purpose and assertions require actual CEF are skipped
when CEF is not bundled.

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
   `hutch.config.ts`, and then advances the matching beta template catalog;
6. runs template acceptance on macOS ARM64, Windows x64, and Linux x64/ARM64.
   From an isolated Hutch home it resolves the published release's paired Hutch,
   uses `hutch electrobun init` to download and install the public `hello-world`
   template, checks the generated pins, builds it, and observes native startup.
   A separate CI fixture goes through `init` using a loopback catalog and the
   real published devkit/runtime. It verifies the install hook, SQL/SQLite
   capability detection, an explicit hashing capability override, and a system
   webview RPC round trip before exiting successfully. Linux runs under Xvfb.

Template acceptance tests the published channel, so it runs **after** publication:
a failure marks the release workflow red but does not roll back public artifacts.
It does not replace the full template QA dashboard or `test:vm` (including CEF).
Every command has a deadline; reports and stage logs are retained as CI artifacts.
To run the same acceptance test locally against a published release:

```sh
node scripts/accept-published-template.mjs --version 2.0.2 --platform macos-arm64 --output /tmp/template-acceptance
```

Use `windows-x64`, `linux-x64`, or `linux-arm64` for the other supported hosts.
The exact version must still be current in its stable/beta template catalog;
the harness fails rather than silently testing a different release. A desktop
session (or Xvfb on Linux) is required. The private fixture lives under
`scripts/fixtures/template-acceptance` and is not listed in the public catalog.

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
