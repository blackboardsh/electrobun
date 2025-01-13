import { $ } from "bun";

await $`rm -r dist`.catch(() => {});
await $`mkdir -p dist/api`;
await $`mkdir -p dist/api/bun`;
await $`mkdir -p dist/api/browser`;
await $`cp src/launcher/zig-out/bin/launcher dist/launcher`;
await $`cp src/extractor/zig-out/bin/extractor dist/extractor`;
await $`cp src/bsdiff/zig-out/bin/bsdiff dist/bsdiff`;
await $`cp src/bsdiff/zig-out/bin/bspatch dist/bspatch`;
await $`cp src/zig/zig-out/bin/webview dist/webview`;
await $`cp node_modules/.bin/bun dist/bun`;
await $`cp src/cli/build/electrobun dist/electrobun`;
await $`cp -r src/bun/ dist/api/bun/`;
await $`cp -r src/browser/ dist/api/browser/`;
await $`cp -r src/zig/build/libObjcWrapper.dylib dist/libObjcWrapper.dylib`;
await $`cp -r vendors/cef/Release/Chromium\ Embedded\ Framework.framework dist/Chromium\ Embedded\ Framework.framework`;
