## Project Structure

/src
/src/browser - compiles to the in-webview electrobun javascript api
/src/bun - compiles to the main process bun code
/src/objc - c-abi wrapped objective c, compiled to a static lib
/src/zig - compiles to the native renderer process. zig abstracts over native apis, sometimes using objc
/src/zig/build - where the compiled src/browser and src/objc ends up so zig can see it and embed it
/example - examples using the library

## Building

Tldr;

- clang to compile objective c wrappers for macos in src/objc (.m files) into a static library, since objc is a superset of c the wrappers have intentionally been designed with c-compatible wrappers/apis
- zig is built with zig's build system. must specify zig equivalent types for objc wrappers to map memory
- electrobun in-webview-api that runs in all frames of the webviews is built using bun with a browser target
- the in-webview-api and objc are built into src/zig/build/ so zig can see it

## IPC

Bun runs the zig process that manages native bindings across platforms as a spawned process.

There are two categories of named pipes for IPC.

1. bun <-> zig use a single shared pipe. this is used for creating windows and webviews, and native handlers that need a response from bun like will-navigate.
2. bun <-> webview. each webview gets its own named pipe for communicating with bun.

bun <-> zig
There is a primary named pipe used to send rpc-anywhere encoded json messages between bun and zig on this pipe. There is a minimal zig implementation of rpc-anywhere that also implements a promise-like api in zig (freezes the main thread while waiting and unfreezes it returning a value).

bun <-> webview
When creating a webview a new named pipe is created. zig creates a bridge between the named pipe and the webview that passes anything between the named pipe and the webview. We also have code in the webview for handling the other end of the RPC anywhere bun<->webview communication. By using a named pipe for each webview we eliminate the need for the zig bridge having to double wrap or partially de/serialize json messages to route them to the right webview which makes bun <-> webview communciation significantly faster.
