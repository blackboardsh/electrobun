# CEF Version Management

Internal reference for how Electrobun manages CEF (Chromium Embedded Framework) versions, builds, and distribution.

## Tarball Layout

Electrobun releases ship 3 tarballs per platform:

| Tarball | Contents | Source |
|---------|----------|--------|
| `electrobun-cli-*` | CLI binary | `bin/` |
| `electrobun-core-*` | Platform binaries including `process_helper` | `dist/` (excluding `cef/` dir and files starting with "electrobun") |
| `electrobun-cef-*` | CEF runtime files only (no electrobun code) | `dist/cef/` |

`process_helper` ships in the **core** tarball, not the CEF tarball. This means the CEF tarball contains only upstream CEF distribution files and can be swapped independently.

## How CEF Gets Built

The default CEF version is hardcoded in `package/build.ts`:

```typescript
const CEF_VERSION = `144.0.11+ge135be2`;
const CHROMIUM_VERSION = `144.0.7559.97`;
```

When `bun build.ts` runs, `vendorCEF()` does the following:

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

## Custom CEF Versions (End-User Flow)

Developers using electrobun via npm can override the CEF version in their `electrobun.config.ts`:

```typescript
export default {
  build: {
    cefVersion: "145.0.1+gabcdef0+chromium-145.0.7600.50",
    // ...
  },
} satisfies ElectrobunConfig;
```

When set, the CLI's `downloadAndExtractCustomCEF()` function:

1. Downloads the minimal distribution from Spotify CDN
2. Extracts it
3. Copies runtime files from `Release/` and `Resources/` to the flat `cef/` layout
4. Writes a `.cef-version` stamp for cache detection

No compilation happens. `process_helper` is already in the core tarball and works with the swapped CEF runtime via the stable C API.

### C API Compatibility

CEF's C API is designed for ABI stability within the same major version line. `process_helper` statically links `libcef_dll_wrapper.a` compiled against the release's default CEF headers. When a developer uses a different CEF version, the C API must be compatible. Across major versions, breaking changes are possible.

## Weekly CEF Version Check

`.github/workflows/cef-check.yml` runs weekly (Monday 09:00 UTC) and can be triggered manually. It runs `package/scripts/check-latest-cef.ts` which:

1. Fetches `https://cef-builds.spotifycdn.com/linux64_builds_index.json`
2. Finds the latest stable version
3. Compares with `CEF_VERSION` in `build.ts`
4. Emits a `::notice` annotation if they differ

## Bumping the CEF Version

1. Update `CEF_VERSION` and `CHROMIUM_VERSION` in `package/build.ts`
2. Delete `vendors/cef/` locally (or the `.cef-version` stamp -- staleness detection will clean it automatically)
3. Run `bun build.ts` -- it will download the new CEF, rebuild `libcef_dll_wrapper.a` and `process_helper`
4. Test with the kitchen app (`bun dev` from `package/`)
5. The release workflow's CEF vendor cache key includes the version, so CI will automatically re-download and rebuild on the next release

## File Reference

| File | Role |
|------|------|
| `package/build.ts` | `CEF_VERSION`/`CHROMIUM_VERSION` constants, `vendorCEF()`, `copyToDist()` |
| `package/src/cli/index.ts` | `CEF_HELPER_*` path constants, `downloadAndExtractCustomCEF()`, `ensureCEFDependencies()` |
| `package/scripts/package-release.js` | Creates the 3 tarballs from `dist/` and `bin/` |
| `package/scripts/check-latest-cef.ts` | Queries Spotify CDN for latest stable CEF version |
| `.github/workflows/release.yml` | Build + release workflow with CEF and process_helper caches |
| `.github/workflows/cef-check.yml` | Weekly CEF version check |
| `package/src/native/macos/cef_process_helper_mac.cc` | macOS process_helper source |
| `package/src/native/win/cef_process_helper_win.cpp` | Windows process_helper source |
| `package/src/native/linux/cef_process_helper_linux.cpp` | Linux process_helper source |
| `package/src/native/linux/cef_loader.{h,cpp}` | dlopen-based CEF loading for Linux |
