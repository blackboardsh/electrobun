## Project Structure

/src
/src/bun - compiles to the main process bun code
/src/zig - compiles to the native renderer process. zig abstracts over native apis, sometimes using objc
/src/browser - compiles to the in-webview javascript
/example - examples using the library

## Building

Tldr;

- clang to compile objective c wrappers for macos in src/zig/macos/objc (the .h and .m files) into a dynamic library, since objc is a superset of c the wrappers have intentionally been designed with c-compatible wrappers/apis
- zig is built with zig's build system. use zig ffi/dlopen to integrate with the objc wrappers, as well as zig-objc to msgsend into the objc runtime.
- electrobun in-webview-api that runs in all frames of the webviews is built using bun with a browser target
- the in-webview-api and objc are built into src/zig/build/ so zig can see it
