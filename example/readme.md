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
