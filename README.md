<p align="center">
  <a href="https://electrobun.dev"><img src="https://github.com/blackboardsh/electrobun/assets/75102186/8799b522-0507-45e9-86e3-c3cfded1aa7c" alt="Logo" height=170></a>
</p>
<h1 align="center">Electrobun</h1>

<div align="center">
  Get started with a template <br />
  <code><strong>npx electrobun init</strong></code>   
</div>



## What is Electrobun?

Electrobun aims to be a complete **solution-in-a-box** for building, updating, and shipping ultra fast, tiny, and cross-platform desktop applications written in Typescript.
Under the hood it uses <a href="https://bun.sh">bun</a> to execute the main process and to bundle webview typescript, and has native bindings written in <a href="https://ziglang.org/">zig</a>.

Visit <a href="https://blackboard.sh/electrobun/">https://blackboard.sh/electrobun/</a> to see api documentation, guides, and more.

**Project Goals**

- Write typescript for the main process and webviews without having to think about it.
- Isolation between main and webview processes with fast, typed, easy to implement RPC between them.
- Small self-extracting app bundles ~12MB (when using system webview, most of this is the bun runtime)
- Even smaller app updates as small as 14KB (using bsdiff it only downloads tiny patches between versions)
- Provide everything you need in one tightly integrated workflow to start writing code in 5 minutes and distribute in 10.

## Apps Built with Electrobun
- [Co(lab)](https://blackboard.sh/colab/) - a hybrid web browser + code editor for deep work

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=blackboardsh/electrobun&type=date&legend=top-left)](https://www.star-history.com/#blackboardsh/electrobun&type=date&legend=top-left)

## Contributing
Ways to get involved:

- Follow us on X for updates <a href="https://twitter.com/BlackboardTech">@BlackboardTech</a> or <a href="https://bsky.app/profile/yoav.codes">@yoav.codes</a>
- Join the conversation on <a href="https://discord.gg/ueKE4tjaCE">Discord</a>
- Create and participate in Github issues and discussions
- Let me know what you're building with Electrobun

## Development Setup
Building apps with Electrobun is as easy as updating your package.json dependencies with `npm add electrobun` or try one of our templates via `npx electrobun init`.

**This section is for building Electrobun from source locally in order to contribute fixes to it.**

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

On Ubuntu/Debian based distros: `sudo apt install build-essential cmake pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`

### First-time Setup

```bash
git clone --recurse-submodules https://github.com/blackboardsh/electrobun.git
cd electrobun/package
bun install
bun dev:clean
```

### Development Workflow

```bash
# All commands are run from the /package directory
cd electrobun/package

# After making changes to source code
bun dev

# If you only changed kitchen sink code (not electrobun source)
bun dev:rerun

# If you need a completely fresh start
bun dev:clean
```

### Additional Commands

All commands are run from the `/package` directory:

- `bun dev:canary` - Build and run kitchen sink in canary mode
- `bun build:dev` - Build electrobun in development mode
- `bun build:release` - Build electrobun in release mode

### Debugging

**macOS:** Use `lldb <path-to-bundle>/Contents/MacOS/launcher` and then `run` to debug release builds
