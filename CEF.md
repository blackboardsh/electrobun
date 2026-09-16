# CEF Version Management

Internal reference for how Electrobun manages CEF (Chromium Embedded Framework) versions, builds, and distribution.

## Tarball Layout

Electrobun application artifacts include 2 tarballs per platform:

| Tarball | Contents | Source |
|---------|----------|--------|
| `electrobun-core-*` | Platform binaries including `process_helper` | `dist/` (excluding `cef/`) |
| `electrobun-cef-*` | CEF runtime files only (no electrobun code) | `dist/cef/` |

The same GitHub Release also carries the four paired Hutch bootstrap archives
indexed by `hutch-artifacts.json`; those are separate from the application
core/CEF payload layout described here.

`process_helper` ships in the **core** tarball, not the CEF tarball. The CEF
tarball therefore contains only upstream runtime files and can be downloaded
and installed independently; the Electrobun release's artifact index still pins
its exact digest.

## How CEF Gets Built

The default CEF version is declared once in
`package/src/shared/cef-version.ts`:

```typescript
export const CEF_VERSION = `147.0.10+gd58e84d`;
export const CHROMIUM_VERSION = `147.0.7727.118`;
```

When `hutch build.ts` runs, `vendorCEF()` does the following:

1. **Downloads** the CEF minimal distribution from `cef-builds.spotifycdn.com`
2. **Builds `libcef_dll_wrapper.a`** using cmake (thin C++ wrapper around CEF's stable C API)
3. **Compiles `process_helper`** from source (`src/native/{platform}/cef_process_helper_*`)

Then `copyToDist()` copies CEF runtime files to `dist/cef/` and `process_helper` to `dist/`.

### What links what

```
process_helper
  statically links libcef_dll_wrapper.a  (compiled in at build time)
    calls CEF C API symbols (cef_execute_process, etc.)
      resolved at runtime from libcef.so / .dll / .framework

libNativeWrapper
  statically links libcef_dll_wrapper.a  (compiled in at build time)
    runtime loading of libcef via:
      macOS: weak_framework
      Windows: DELAYLOAD
      Linux: dlopen (cef_loader.cpp)
```

`libcef_dll_wrapper.a` is a link-time dependency for both `process_helper` and `libNativeWrapper`. It does NOT contain any CEF implementation -- it just forwards C++ calls to CEF's C API, which is resolved at runtime from the actual CEF shared library.

## Release Workflow Caching

The release workflow (`.github/workflows/release.yml`) caches two things to avoid redundant work:

### CEF vendor cache
```
key: cef-{platform}-{arch}-{cef_version}
path: package/vendors/cef
```
Covers the CEF download and `libcef_dll_wrapper.a` build. On cache hit, cmake doesn't re-run.

### process_helper cache
```
key: process-helper-{platform}-{arch}-{cef_version}-{hash of cef_process_helper_* sources}
path: package/src/native/build/process_helper[.exe]
```
`process_helper` rarely changes. This cache skips its compilation when neither the CEF version nor the helper source code changed. `build.ts` checks for the binary's existence and skips building if present.

`libNativeWrapper` is NOT cached because it changes frequently.

## Application Artifact Resolution

CEF is owned by the resolved Electrobun release; there is no separate
per-project CEF version override. An exact `electrobun.version` pin wins over
the npm-paired or floating channel default. The release publishes a verified
CEF tarball separately from the core tarball so projects that do not enable CEF
do not download it. When CEF is enabled and its matching payload is not already
installed, Hutch fetches the selected release's artifact index, verifies the
CEF archive, and installs it under
`~/.hutch/releases/electrobun` before packaging the app. The artifact index is
fetched fresh and is not stored persistently; an already-installed verified CEF
payload can be reused offline.

The core tarball's native devkit manifest describes the CEF-capable wrapper and
`process_helper` runtime paths. The artifact index—not the npm bootstrap or the
devkit manifest—owns the CEF download URL, size, and SHA-256 digest.

## Weekly CEF Version Check

`.github/workflows/cef-check.yml` runs weekly (Monday 09:00 UTC) and can be
triggered manually. It runs `package/scripts/update-cef-version.ts`, which:

1. Fetches the Spotify CEF build index
2. Finds the latest stable version
3. Compares it with `package/src/shared/cef-version.ts`
4. Updates that file in the CI checkout and reports `has_update=true` when they differ

The workflow then builds against the candidate version and records whether it
is compatible; the scheduled job does not commit the update.

## Bumping the CEF Version

1. Update `CEF_VERSION` and `CHROMIUM_VERSION` in `package/src/shared/cef-version.ts`
2. Delete `vendors/cef/` locally (or the `.cef-version` stamp -- staleness detection will clean it automatically)
3. Run `hutch build.ts` -- it will download the new CEF, rebuild `libcef_dll_wrapper.a` and `process_helper`
4. Test with the kitchen app (`hutch dev` from `package/`)
5. The release workflow's CEF vendor cache key includes the version, so CI will automatically re-download and rebuild on the next release

## File Reference

| File | Role |
|------|------|
| `package/build.ts` | `vendorCEF()` and `copyToDist()` build/staging implementation |
| `package/src/shared/cef-version.ts` | Authoritative CEF and Chromium version pair |
| `package/src/shared/native-devkit-manifest.ts` | Describes CEF-capable runtime paths exposed to Hutch |
| `package/scripts/package-release.js` | Creates the core and optional CEF tarballs from `dist/` |
| `package/scripts/update-cef-version.ts` | Checks the latest stable CEF version and updates the source pair in its checkout |
| `.github/workflows/release.yml` | Build + release workflow with CEF and process_helper caches |
| `.github/workflows/cef-check.yml` | Weekly CEF version check |
| `package/src/native/macos/cef_process_helper_mac.cc` | macOS process_helper source |
| `package/src/native/win/cef_process_helper_win.cpp` | Windows process_helper source |
| `package/src/native/linux/cef_process_helper_linux.cpp` | Linux process_helper source |
| `package/src/native/linux/cef_loader.{h,cpp}` | dlopen-based CEF loading for Linux |
