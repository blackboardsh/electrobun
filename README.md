<p align="center">
  <a href="https://electrobun.dev"><img src="https://github.com/blackboardsh/electrobun/assets/75102186/8799b522-0507-45e9-86e3-c3cfded1aa7c" alt="Logo" height=170></a>
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
- Small app bundles ~18MB zipped (when using system webview, 99% of this is the bun runtime zipped)
- Even smaller app updates < 200KB (when only your app code changes users just download that, so you can ship at web speed)
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

On the road to a stable 1.0.0 I'm probably going to just be pushing directly to main a lot.

As we get closer to 1.0.0 I'll probably make guidelines for PRs and stuff. In the meantime if you find this project and want to contribute code it's probably best to create an issue first or ping me on twitter or discord to discuss when, what, and how is best to do that.

Ways to get involved at this early stage:

- Follow us on X for updates <a href="https://twitter.com/BlackboardTech">@BlackboardTech</a>
- Join the conversation on Discord
- Create and participate in Github issues and discussions
