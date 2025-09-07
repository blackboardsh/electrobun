<p align="center">
  <a href="https://electrobun.dev"><img src="https://github.com/blackboardsh/electrobun/assets/75102186/8799b522-0507-45e9-86e3-c3cfded1aa7c" alt="Logo" height=170></a>
</p>
<h1 align="center">Electrobun</h1>

<div align="center">
</div>

## What is Electrobun?

> Electrobun is in the **_very_** early stages. We currently support development on macOS, Windows, and Linux, but it has memory leaks, has no tests, and many core things are still missing. We're actively working on stabilizing cross-platform support.

Electrobun aims to be a complete **solution-in-a-box** for building, updating, and shipping ultra fast, tiny, and cross-platform desktop applications written in Typescript.
Under the hood it uses <a href="https://bun.sh">bun</a> to execute the main process and to bundle webview typescript, and has native bindings written in <a href="https://ziglang.org/">zig</a>.

Visit <a href="https://www.electrobun.dev/">Electrobun.dev</a> to see api documentation, guides, and more.

**Project Goals**

- Write typescript for the main process and webviews without having to think about it.
- Isolation between main and webview processes with fast, typed, easy to implement RPC between them.
- Small self-extracting app bundles ~12MB (when using system webview, most of this is the bun runtime)
- Even smaller app updates as small as 14KB (using bsdiff it only downloads tiny patches between versions)
- Provide everything you need in one tightly integrated workflow to start writing code in 5 minutes and distribute in 10.

## Architecture

Read about how Electrobun is designed, and why, in our <a href="https://www.electrobun.dev/docs/guides/Architecture/Overview">architecture docs</a>.

## Roadmap

See the <a href="https://github.com/orgs/blackboardsh/projects/5">roadmap</a>

## Contributing

On the road to a stable 1.0.0 I'm probably going to just be pushing directly to main a lot.

As we get closer to 1.0.0 I'll probably make guidelines for PRs and stuff. In the meantime if you find this project and want to contribute code it's probably best to create an issue first or ping me on twitter or discord to discuss when, what, and how is best to do that.

Ways to get involved at this early stage:

- Follow us on X for updates <a href="https://twitter.com/BlackboardTech">@BlackboardTech</a> or <a href="https://bsky.app/profile/yoav.codes">@yoav.codes</a>
- Join the conversation on <a href="https://discord.gg/ueKE4tjaCE">Discord</a>
- Create and participate in Github issues and discussions

## Development Setup

### Prerequisites

**macOS:**
- Xcode command line tools
- cmake (install via homebrew: `brew install cmake`)

**Windows:**
- Visual Studio Build Tools or Visual Studio with C++ development tools
- cmake

**Linux:**
- build-essential package
- cmake
- webkit2gtk and GTK development packages

### First-time Setup

**⚠️ Important: Initialize Git Submodules**

After cloning the repository, initialize submodules before installing dependencies, then do a clean first run:

```bash
git clone https://github.com/blackboardsh/electrobun.git
cd electrobun
git submodule update --init --recursive
bun install
bun dev:playground:clean
```

The `src/bsdiff/zstd` directory is a git submodule and is required for builds.

### Development Workflow

All development commands now use cross-platform TypeScript scripts that work identically on Windows, macOS, and Linux:

```bash
# After making changes to source code
bun dev:playground

# If you only changed playground code (not electrobun source)
bun dev:playground:rerun

# If you need a completely fresh start
bun dev:playground:clean
```

### Development Commands

**Playground Development:**
- `bun dev:playground` - Build and run playground
- `bun dev:playground:canary` - Build and run playground in canary mode
- `bun dev:playground:linux` - Build and run playground with npm link (Linux/macOS)
- `bun dev:playground:clean` - Clean and rebuild everything
- `bun dev:playground:rerun` - Just run playground without rebuilding
- `bun run:playground` - Build and run interactive-playground template

**Build Commands:**
- `bun build:dev` - Build electrobun in development mode
- `bun build:release` - Build electrobun in release mode
- `bun build:cli` - Build the CLI executable

**Testing & Documentation:**
- `bun test` - Build and run tests
- `bun dev:docs` - Start documentation development server
- `bun build:docs:release` - Build documentation for release

**Script Organization:**
All development scripts are organized by category in the `scripts/` directory:
- `playground.ts` - Playground development workflows
- `test.ts` - Test execution
- `build.ts` - Build processes
- `docs.ts` - Documentation tasks

See `scripts/README.md` for detailed documentation.

**Note:** All development scripts have been rewritten as cross-platform TypeScript to fix Windows compatibility issues with shell commands like `cd` and `rm -rf`.

### Debugging

**macOS:** Use `lldb <path-to-bundle>/Contents/MacOS/launcher` and then `run` to debug release builds
