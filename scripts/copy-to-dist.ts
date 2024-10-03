import { $ } from "bun";
import { rmdirSync } from "fs";

// await $`rm -r dist`; // this segfaults in current bun
rmdirSync("dist", { recursive: true });
await $`mkdir -p dist/api`;
await $`cp src/launcher/zig-out/bin/launcher dist/launcher`;
await $`cp src/extractor/zig-out/bin/extractor dist/extractor`;
await $`cp src/bsdiff/zig-out/bin/bsdiff dist/bsdiff`;
await $`cp src/bsdiff/zig-out/bin/bspatch dist/bspatch`;
await $`cp src/zig/zig-out/bin/webview dist/webview`;
await $`cp node_modules/.bin/bun dist/bun`;
await $`cp src/cli/build/electrobun dist/electrobun`;
await $`bun build --target=bun --sourcemap=external --outdir=dist/api/bun src/bun/index.ts`;
await $`bun build --target=browser --sourcemap=external --outdir=dist/api/browser src/browser/index.ts`;
