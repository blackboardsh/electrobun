<p align="center">
  <a href="https://electrobun.dev"><img src="https://github.com/blackboardsh/electrobun/assets/75102186/8799b522-0507-45e9-86e3-c3cfded1aa7c" alt="Logo" height=170></a>
</p>
<h1 align="center">Electrobun</h1>

<div align="center">
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

## Architecture

Read about how Electrobun is designed, and why, in our <a href="https://www.electrobun.dev/docs/guides/Architecture/Overview">architecture docs</a>.

## Apps Built with Electrobun
- [Co(lab)](https://blackboard.sh/colab/) - a hybrid web browser + code editor for deep work

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

On Ubuntu/Debian based distros: `sudo apt install build-essential cmake pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`

### First-time Setup

```bash
git clone --recurse-submodules https://github.com/blackboardsh/electrobun.git
cd electrobun
bun install
bun dev:playground:clean
# On Linux, use:
bun dev:playground:clean:linux
```

### Development Workflow

```bash
# After making changes to source code
bun dev:playground
# On Linux, use:
bun dev:playground:linux

# If you only changed playground code (not electrobun source)
bun dev:playground:rerun

# If you need a completely fresh start
bun dev:playground:clean
# On Linux, use:
bun dev:playground:clean:linux
```

### Additional Commands

- `bun dev:playground:canary` - Build and run playground in canary mode
- `bun build:dev` - Build electrobun in development mode
- `bun build:release` - Build electrobun in release mode

### Debugging

**macOS:** Use `lldb <path-to-bundle>/Contents/MacOS/launcher` and then `run` to debug release builds
