## Project Structure

/src
/src/bun - compiles to the main process bun code
/src/zig - compiles to the native renderer process. zig abstracts over native apis, sometimes using objc
/src/browser - compiles to the in-webview javascript
/example - examples using the library
