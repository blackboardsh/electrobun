## Project Structure

<pre>
/src - electrobun's src code
/src/browser - typescript compiles to the in-webview electrobun javascript api
/src/bun - typescript compiles to the main process javascript api
/src/objc - c-abi wrapped objective c, compiled to a static lib
/src/zig - zig native bindings, compiles to the native renderer process. 
/src/zig/build - where the compiled src/objc ends up so zig can see it and embed it
/src/cli - a cli for building and running developer apps, it reads electrobun.config files
/playground - Interactive playground using the library. 
</pre>

## Building

Tldr;

- clang to compile objective c wrappers for macos in src/objc (.m files) into a static library, since objc is a superset of c the wrappers have intentionally been designed with c-compatible wrappers/apis
- zig is built with zig's build system. must specify zig equivalent types for objc wrappers to map memory
- electrobun in-webview-api that runs in all frames of the webviews is built using bun with a browser target
- the in-webview-api and objc are built into src/zig/build/ so zig can see it

## Working on Electrobun

There are some npm scripts to facilitate building everything from the objc, zig, bundling webview api, transpiling the bun api and so an, as well as building the playground app and executing it.

The playground app is meant to be an interactive playground of Electrobun's functionality, it's useful when implementing new functionality in any part of Electrobun to have everything rebuilt so you can interact with it in the playground app which then doubles as a demo app for developers wanting to explore what Electrobun can do.

You currently need zig installed globally, and to be on an ARM mac. I dunno if you have to install xcode or xcode tools to get clang on your system. Will iron out a better dev flow in the future.

For now you can simply

1. clone the repo
2. in the repo root run `bun run dev:playground`

If you take a look at the repo's package.json as well as playground app's package.json and electrobun.config you'll get a better sense of what's happening for each step.

## How Developer apps are built

> Note: in order for an application to get keyboard focus on macos you can't run it as a subprocess of the terminal which greedily steals keyboard input, so it needs to be built into an app bundle.

This part is wip, but currently we create a minimal macos app bundle and execute it. There is a launcher shell script which calls bun with your typescript. It configures stdout/err to write to a named pipe log file and starts listening to it so you get the output in the terminal.

You can cmd+c to stop that, but for now to quit your running app you have to close the window.

A better dev flow, as well as installing bun to a global location outside the app bundle is being actively developed.
