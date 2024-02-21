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

## Events

Electrobun.events is a custom event emitter. If we look at how the 'will-navigate' event works.

1. zig sends json rpc request to decide navigation over the main bun named pipe with a url and a webviewid
2. zig pauses the main thread simulating a promise-ish while listening on a separate named pipe listener thread
3. bun parses the json rpc and sees it's a 'will navigate' request
4. bun creates a new Electrobun.events.webview.willNavigate event with the data (url and webviewid).
5. bun then emits the event globally ('will-navigate') that could be listened to with Electrobun.events.on('will-navigate')
6. bun the passes the same event to a specific event ('will-navigate-<webviewId>' ie: will-navigate-1 for the webivew with id 1)
7. you could listen to this globally via Electrobun.events.on('will-navigate-1') if you wanted to. Since ids are incremented deterministically this allows for some interesting patterns like handling navigation for the first window created
8. you can also listen on the webview with myWebview.on('will-navigate'). Webview extends a "event emitter class' that essentially provides on, off, appendEventListener, etc. but instead of being an event listener it modifies the event name to include its id, and subscribes the handler to the main event emitter. So it basically does Electrobun.events.on('will-navigate-1') for you without you having to think about the webview's id and providing other lifecycle handling for you.
9. the event object has a response getter/setter and a clearResponse method that allows any handler to respond with a value as well as a 'responseWasSet' flag. so in any handler you can both check if another handler set a response, and if you want override or modify the response.
10. the response is then sent serialized as an rpc response and sent back to zig which is listening on another thread and unfreezes the main thread returning the value

So global events are always called before specific events.
