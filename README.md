<p align="center">
  <a href="https://electrobun.dev"><img src="https://github.com/blackboardsh/electrobun/assets/75102186/35b21093-1f29-44bc-a359-57ead6c19ab8" alt="Logo" height=170></a>
</p>
<h1 align="center">Electrobun</h1>

<div align="center">
</div>

## What is Electrobun?

> Electron is in the **_very_** early stages. We currently only support development on arm macs, it has memory leaks, has no tests, it's not available in npm yet, and many core things are still missing.

Electrobun aims to be a complete **solution-in-a-box** for building, updating, and shipping ultra fast, tiny, and cross-platform desktop applications written in Typescript.
Under the hood it uses <a href="https://bun.sh">bun</a> to execute the main process and to bundle webview typescript, and has native bindings written in <a href="https://ziglang.org/">zig</a>.

**Project Goals**

- Write typescript for the main process and webviews without having to think about it.
- Isolation between main and webview processes with fast RPC between them.
- Decouple shipping Bun and Web runtimes from shipping your application code.
- Small app bundles < 5MB
- Provide everything you need in one tightly integrated workflow to start writing code in 5 minutes and distribute in 10.

## Architecture

Read about how Electrobun is designed, and why, in our <a href="blackboardsh/electrobun/tree/main/docs/architecture.md">architecture docs</a>.

## Roadmap

See the detailed <a href="https://github.com/blackboardsh/electrobun/issues/2">detailed Roadmap</a>.

**High level roadmap**

|     | Milestones            | Description                                                                                                         |
| :-- | :-------------------- | :------------------------------------------------------------------------------------------------------------------ |
| ✅  | Core Architecture     | Ship a working proof of concept with most of the core architecture wired up                                         |
|     | Packaging and signing | Packaging and code signing for MacOS                                                                                |
|     | Shipping updates      | Integrated auto-updator                                                                                             |
|     | Custom Web Runtime    | Optionally use a cross-platform web runtime (Chromium) instead of the system's native webview                       |
|     | Intel Mac Builds      | build on and distribute to intel macs                                                                               |
|     | API Parity            | Accelerate development of Electrobun apis and native integrations to enable apps to migrate from Electron and Tauri |
|     | Windows support       | build for and distribute to Windows                                                                                 |

## Contributing

Ways to get involved at this early stage:

- Follow us on X for updates:
- Join the conversation on Discord
- Create and participate in Github issues and discussions
