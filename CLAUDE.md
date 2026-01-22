# Claude Development Guidelines for Electrobun

## Building and Running Electrobun

### IMPORTANT: Build Commands

**NEVER** run electrobun directly from the bin folder or node_modules. The correct way to build and run Electrobun is:

1. **From the package folder** (`/home/yoav/code/electrobun/package/`):
   - `bun dev` - Builds and runs the kitchen app in dev mode
   - `bun dev:canary` - Builds the kitchen app in canary mode

2. **Build Process Flow**:
   - Always run build commands from the `package` folder
   - The build process will automatically:
     - Build the native wrappers
     - Compile the TypeScript code
     - Build the CLI
     - Switch to the kitchen folder and build/run the app

## Project Structure

- `/package` - Main Electrobun package source
- `/kitchen` - Test application (Kitchen Sink)
- `/package/src/cli` - CLI implementation
- `/package/src/extractor` - Self-extractor implementation (Zig)
- `/package/src/native` - Native wrappers for each platform
