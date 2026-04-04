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
- [24agents](https://github.com/jhsu/24agents) - Hyperprompter
- [act-track-ai](https://github.com/IrdanGu/act-track-ai) - personal desktop productivity tracker
- [Agents Council](https://github.com/MrLesk/agents-council) - agent-to-agent MCP communication tool for feedback requests
- [ai-wrapped](https://github.com/gulivan/ai-wrapped) - Wrapped-style desktop dashboard for your AI coding agent activity
- [Audio TTS](https://github.com/blackboardsh/audio-tts) - desktop text-to-speech app using Qwen3-TTS for voice design, cloning, and generation
- [aueio-player-desktop](https://github.com/tuomashatakka/aueio-player-desktop) - beautiful, minimal cross-platform audio player
- [bestdiff](https://github.com/tesmond/bestdiff) - a git diff checker with curved connectors
- [BuddyWriter](https://github.com/OxFrancesco/BuddyWriter) - BuddyWriter desktop and mobile apps
- [burns](https://github.com/l3wi/burns) - a Smithers manager
- [cbx-tool](https://github.com/jebin2/cbx-tool) - desktop app for reading and editing comic book archives (.cbz/.cbr)
- [Co(lab)](https://blackboard.sh/colab/) - a hybrid web browser + code editor for deep work
- [codlogs](https://github.com/tobitege/codlogs) - search and export local Codex sessions via CLI or desktop app
- [Codex Agents Composer](https://github.com/MrLesk/codex-agents-composer) - desktop app for managing your Codex agents and their skills
- [codex-devtools](https://github.com/gulivan/codex-devtools) - desktop inspector for Codex session data; browse conversations, search messages, and analyze agent activity
- [Deskdown](https://github.com/guarana-studio/deskdown) - transform any web address into a desktop app in under 20 seconds
- [dev-3.0](https://github.com/h0x91b/dev-3.0) - helps you not get lost while managing multiple AI agents across projects
- [DOOM](https://github.com/blackboardsh/electrobun-doom) - DOOM implemented in 2 ways: bun -> (c doom -> bundled wgpu) and (full ts port bun -> bundled wgpu)
- [electrobun-pdf](https://github.com/GijungKim/electrobun-pdf) - local-first PDF & DOCX editor for opening, annotating, and exporting documents without leaving your machine
- [electrobun-rms](https://github.com/khanhthanhdev/electrobun-rms) - fast Electrobun desktop app template with React, Tailwind CSS, and Vite
- [golb](https://github.com/chrisdadev13/golb) - desktop AI coding workspace built with React, Vite, and Tailwind
- [GOG Achievements GUI](https://github.com/timendum/gog-achievements-gui) - desktop app for managing GOG achievements
- [groov](https://github.com/laurenzcodes/groov) - desktop audio deck monitor
- [Guerilla Glass](https://github.com/okikeSolutions/guerillaglass) - open-source cross-platform creator studio for fast Record -> Edit -> Deliver workflows
- [Marginalia](https://github.com/lars-hoeijmans/Marginalia) - a simple note taking app
- [MarkBun](https://github.com/xiaochong/markbun) - fast, beautiful, Typora-like markdown desktop editor
- [md-browse](https://github.com/needle-tools/md-browse) - a markdown-first browser that converts web pages to clean markdown
- [Patchline](https://github.com/adwaithks/Patchline) - lightweight desktop Git client for reading patches and line diffs, then staging and committing changes
- [peekachu](https://github.com/needle-tools/peekachu) - password manager for AIs; store secrets in your OS keychain and scrub output so AI assistants never see actual values
- [PiBun](https://github.com/khairold/pibun) - desktop GUI for the Pi coding agent with chat, terminal, git integration, and plugin system
- [PLEXI](https://github.com/ianjamesburke/PLEXI) - a multi-dimensional terminal multiplexer for the agentic era
- [Prometheus](https://github.com/opensourcectl/prometheus) - desktop utility toolbox for file cleanup, document manipulation, and image processing
- [Quiver](https://ataraxy-labs.github.io/quiver/) - desktop app for GitHub PR reviews, merge conflict resolution, and AI commit messages
- [remotecode.io](https://github.com/samuelfaj/remotecode.io) - continue local AI coding sessions (Claude Code or Codex) from your mobile device
- [sirene](https://github.com/KevinBonnoron/sirene) - self-hosted multi-backend text-to-speech platform with voice cloning
- [StoryForge](https://github.com/vrrdnt/StoryForge) - desktop app for Vintage Story players to switch between game versions, modpacks, servers, and accounts
- [Tensamin Client](https://github.com/Tensamin/Client) - web, desktop, and mobile app for accessing Tensamin
- [tokenpass-desktop](https://github.com/b-open-io/tokenpass-desktop) - desktop app that runs the Sigma Identity stack locally for Bitcoin-backed authentication
- [typsmthng-desktop](https://github.com/aaditagrawal/typsmthng-desktop) - experimental desktop typing application
- [VibesOS](https://github.com/popmechanic/VibesOS) - A GUI for Claude Code that makes it easy to vibe code simple, un-hackable apps
- [VoiceVault](https://github.com/PJH720/VoiceVault) - AI-powered voice recorder with transcription, summarization, and RAG search
- [warren](https://github.com/Loa212/warren) - open-source, peer-to-peer terminal mesh for accessing your machines from any device without SSH keys or config files

### Video Demos

[![Audio TTS Demo](https://img.youtube.com/vi/Z4dNK1d6l6E/maxresdefault.jpg)](https://www.youtube.com/watch?v=Z4dNK1d6l6E)

[![Co(lab) Demo](https://img.youtube.com/vi/WWTCqGmE86w/maxresdefault.jpg)](https://www.youtube.com/watch?v=WWTCqGmE86w)

[![DOOM Demo](https://github.com/user-attachments/assets/6cc5f04a-6d97-4010-b65f-3f282d32590c)](https://x.com/YoavCodes/status/2028499038148903239?s=20)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=blackboardsh/electrobun&type=date&legend=top-left&cache=3)](https://www.star-history.com/#blackboardsh/electrobun&type=date&legend=top-left)

## Contributing
Ways to get involved:

- Follow us on X for updates <a href="https://twitter.com/BlackboardTech">@BlackboardTech</a> and <a href="https://twitter.com/YoavCodes">@YoavCodes</a> or on bluesky <a href="https://bsky.app/profile/yoav.codes">@yoav.codes</a>
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

## Platform Support

| OS | Status |
|---|---|
| macOS 14+ | Official |
| Windows 11+ | Official |
| Ubuntu 22.04+ | Official |
| Other Linux distros (gtk3, webkit2gtk-4.1) | Community |
