# Claude Development Guidelines for Electrobun

## Building and Running Electrobun

### IMPORTANT: Build Commands

**NEVER** run Electrobun from `node_modules`. Electrobun 2 uses Hutch as its
build CLI, with npm only for this repository's development dependencies:

1. **From the package folder** (`/home/yoav/code/electrobun/package/`):
   - `npm ci` - Installs the repository's pinned development dependencies
   - `hutch dev` - Builds and runs the Kitchen app in dev mode
   - `hutch dev:canary` - Builds the Kitchen app in canary mode

2. **Build Process Flow**:
   - Always run build commands from the `package` folder
   - The build process will automatically:
     - Build the native wrappers
     - Compile the TypeScript code
     - Build the versioned core and devkit
     - Switch to the kitchen folder and build/run the app

## Project Structure

- `/package` - Main Electrobun package source
- `/kitchen` - Test application (Kitchen Sink)
- `/npm/electrobun` - Single dependency-free npm bootstrap; it reads the
  same-version GitHub Release's `hutch-artifacts.json`, downloads and verifies
  the paired host archive, then safely caches and invokes the extracted Hutch
  launcher (with no platform npm packages or postinstall script)
- `/package/src/sdks` - Versioned language SDK sources published in the devkit
- `/package/src/extractor` - Self-extractor implementation (Zig)
- `/package/src/native` - Native wrappers for each platform
