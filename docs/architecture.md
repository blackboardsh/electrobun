## Project Structure

<pre>
/src - electrobun's src code
/src/browser - typescript compiles to the in-webview electrobun javascript api
/src/bun - typescript compiles to the main process javascript api
/src/objc - c-abi wrapped objective c, compiled to a static lib
/src/zig - zig native bindings, compiles to the native renderer process. 
/src/zig/build - where the compiled src/objc ends up so zig can see it and embed it
/src/cli - a cli for building and running developer apps, it reads electrobun.config files
/example - Interactive example using the library. 
</pre>

## Building

Tldr;

- clang to compile objective c wrappers for macos in src/objc (.m files) into a static library, since objc is a superset of c the wrappers have intentionally been designed with c-compatible wrappers/apis
- zig is built with zig's build system. must specify zig equivalent types for objc wrappers to map memory
- electrobun in-webview-api that runs in all frames of the webviews is built using bun with a browser target
- the in-webview-api and objc are built into src/zig/build/ so zig can see it

## IPC

Bun spawns the zig bindings as a separate process. GUI applications require the main thread of a process to run a blocking event loop, so this is separate to the bun process.

There are two categories of named pipes for IPC.

1. bun <-> zig. This is used for communicating with zig. ie: creating windows and webviews, and binding native handlers that need a response from bun like will-navigate.
2. bun <-> webview. Each webview gets its own pair of named pipes for communicating with bun.

### bun <-> zig

There is a primary named pipe used to send rpc-anywhere encoded json messages between bun and zig on this pipe. There is a minimal zig implementation of rpc-anywhere that also implements a promise-like api in zig (freezes the main thread while waiting and unfreezes it returning a value).

In order to simulate something promise-like in zig we send the request to bun and pause the main zig thread. We have a pipe listener on another thread waiting for a reply, when it gets a response it unfreezes the main thread and returns the value back to the function that was waiting.

In general (whether receiving rpc requests, responses, and messages from bun) there is a performant loop in zig listening on another thread. We use native functions to group named pipe into a kqueue and let the process subscribe to events that continue the loop so it isn't busy waiting. For any gui-related rpc whe have to pass messages to the main thread to be executed.

### bun <-> webview

When creating a webview a new named pipe pair is created. zig creates a bridge between the named pipe and the webview that passes anything between the named pipe and the webview so it's never deserialized in zig. We also have code in the webview for handling the other end of the RPC anywhere bun<->webview communication. By using a named pipe for each webview we eliminate the need for the zig bridge having to double wrap or partially de/serialize json messages to route them to the right webview which makes bun <-> webview communciation significantly faster.

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

Global events are always called before specific events.

## Working on Electrobun

There are some npm scripts to facilitate building everything from the objc, zig, bundling webview api, transpiling the bun api and so an, as well as building the example app and executing it.

The example app is meant to be an interactive example of Electrobun's functionality, it's useful when implementing new functionality in any part of Electrobun to have everything rebuilt so you can interact with it in the example app which then doubles as a demo app for developers wanting to explore what Electrobun can do.

You currently need zig installed globally, and to be on an ARM mac. I dunno if you have to install xcode or xcode tools to get clang on your system. Will iron out a better dev flow in the future.

For now you can simply

1. clone the repo
2. in the repo root run `bun run dev:example`

If you take a look at the repo's package.json as well as example app's package.json and electrobun.config you'll get a better sense of what's happening for each step.

## How Developer apps are built

> Note: in order for an application to get keyboard focus on macos you can't run it as a subprocess of the terminal which greedily steals keyboard input, so it needs to be built into an app bundle.

This part is wip, but currently we create a minimal macos app bundle and execute it. There is a launcher shell script which calls bun with your typescript. It configures stdout/err to write to a named pipe log file and starts listening to it so you get the output in the terminal.

You can cmd+c to stop that, but for now to quit your running app you have to close the window.

A better dev flow, as well as installing bun to a global location outside the app bundle is being actively developed.
