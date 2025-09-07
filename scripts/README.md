# Electrobun Development Scripts

This directory contains cross-platform TypeScript scripts that replace shell-based commands in `package.json` to ensure consistent behavior across Windows, macOS, and Linux.

## Why These Scripts Exist

The original `package.json` scripts used shell commands like `cd directory && command` and `mkdir -p` that behave inconsistently across platforms:

- **Windows**: Directory changes don't persist across `&&` operators
- **Unix/Linux/macOS**: Directory changes work as expected
- **Security**: `rm -rf` commands were dangerous on Windows

## Script Categories

### 🏗️ Build (`build.ts`)
Handles build-related commands that require cross-platform compatibility.

**Commands:**
- `cli` - Build the CLI executable (replaces `mkdir -p bin && bun build...`)

**Usage:**
```bash
bun scripts/build.ts cli
```

**Package.json scripts:**
- `build:cli`

### 🎮 Playground (`playground.ts`)
Manages playground development workflows with proper directory handling.

**Commands:**
- `playground` - Build and run playground
- `playground:linux` - Build and run playground with npm link (Linux/macOS)
- `playground:clean` - Clean and rebuild everything
- `playground:rerun` - Just run playground without rebuilding
- `playground:canary` - Build and run in canary mode
- `playground:template` - Build and run interactive-playground template

**Usage:**
```bash
bun scripts/playground.ts playground
bun scripts/playground.ts playground:clean
```

**Package.json scripts:**
- `dev:playground`
- `dev:playground:linux`
- `dev:playground:clean`
- `dev:playground:rerun`
- `dev:playground:canary`
- `run:playground`

### 🧪 Test (`test.ts`)
Handles test execution with proper cross-platform directory management.

**Usage:**
```bash
bun scripts/test.ts
```

**Package.json scripts:**
- `test`

### 📚 Documentation (`docs.ts`)
Manages documentation development and building with cross-platform directory changes.

**Commands:**
- `dev` - Start documentation development server
- `build` - Build documentation for release

**Usage:**
```bash
bun scripts/docs.ts dev
bun scripts/docs.ts build
```

**Package.json scripts:**
- `dev:docs`
- `build:docs:release`

## Legacy Scripts

These JavaScript files remain for specialized tasks:

- `build-and-upload-artifacts.js` - Handles artifact uploading (specialized logic)
- `package-release.js` - Manages release packaging (specialized logic)

## Features

All TypeScript scripts include:

✅ **Cross-platform compatibility** - Works identically on Windows, macOS, and Linux  
✅ **Proper error handling** - Exits with appropriate error codes  
✅ **Colored output** - Uses ANSI colors for better readability  
✅ **Directory management** - Uses `process.chdir()` instead of shell `cd`  
✅ **Safe file operations** - Uses Node.js APIs instead of shell commands  
✅ **Submodule checking** - Validates git submodules are initialized  
✅ **Help messages** - Shows usage when called without arguments  

## Development Guidelines

When adding new development scripts:

1. **Use TypeScript** for new scripts
2. **Follow naming pattern**: `{category}.ts`
3. **Include colored logging** using the standard color palette
4. **Add error handling** with proper exit codes
5. **Use Node.js APIs** instead of shell commands when possible
6. **Document commands** in both script comments and this README
7. **Test on all platforms** before committing

## Migration Summary

| Original Script | Issue | New Script | Status |
|----------------|--------|------------|---------|
| `dev:playground` | `cd` doesn't persist on Windows | `playground.ts` | ✅ Fixed |
| `dev:playground:*` | Same `cd` issues | `playground.ts` | ✅ Fixed |
| `test` | `cd tests &&` doesn't work on Windows | `test.ts` | ✅ Fixed |
| `build:cli` | `mkdir -p` not cross-platform | `build.ts` | ✅ Fixed |
| `dev:docs` | `cd documentation &&` doesn't work | `docs.ts` | ✅ Fixed |
| `build:docs:release` | Same `cd` issue | `docs.ts` | ✅ Fixed |

All development scripts are now **100% cross-platform compatible**! 🎉
