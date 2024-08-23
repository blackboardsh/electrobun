## IPC

Bun spawns the zig bindings as a separate process. GUI applications require the main thread of a process to run a blocking event loop, so this is separate to the bun process.

There are two categories of named pipes for IPC.

1. bun \<-> zig. This is used for communicating with zig. ie: creating windows and webviews, and binding native handlers that need a response from bun like will-navigate.
2. bun \<-> webview. Each webview gets its own pair of named pipes for communicating with bun.

### bun \<-> zig

There is a primary named pipe used to send rpc-anywhere encoded json messages between bun and zig on this pipe. There is a minimal zig implementation of rpc-anywhere that also implements a promise-like api in zig (freezes the main thread while waiting and unfreezes it returning a value).

In order to simulate something promise-like in zig we send the request to bun and pause the main zig thread. We have a pipe listener on another thread waiting for a reply, when it gets a response it unfreezes the main thread and returns the value back to the function that was waiting.

In general (whether receiving rpc requests, responses, and messages from bun) there is a performant loop in zig listening on another thread. We use native functions to group named pipe into a kqueue and let the process subscribe to events that continue the loop so it isn't busy waiting. For any gui-related rpc whe have to pass messages to the main thread to be executed.

### bun \<-> webview

When creating a webview a new named pipe pair is created. zig creates a bridge between the named pipe and the webview that passes anything between the named pipe and the webview so it's never deserialized in zig. We also have code in the webview for handling the other end of the RPC anywhere bun\<->webview communication. By using a named pipe for each webview we eliminate the need for the zig bridge having to double wrap or partially de/serialize json messages to route them to the right webview which makes bun \<-> webview communciation significantly faster.
