console.log('hi')
// import { $ } from "bun";
// import { platform } from "os";
// import {join} from 'path';
// import {existsSync} from "fs";

// const isWindows = platform() === "win32";
// const bunBin = isWindows ? "bun.exe" : "bun";

// // prep dist folder

// await $`rm -r dist`.catch(() => {});
// await $`mkdir -p dist/api`;
// await $`mkdir -p dist/api/bun`;
// await $`mkdir -p dist/api/browser`;

// // bun binary
// const bunPath = join(process.cwd(), "vendors", "bun", bunBin);
// const distPath = join(process.cwd(), "dist", bunBin);
// const bunUrlSegment = isWindows && 'bun-windows-x64.exe' || 'bun-darwin-aarch64'
// if (!existsSync(bunPath)) {
//     await $`mkdir -p ${join("vendors", "bun")} && curl -L -o ${bunPath} https://github.com/oven-sh/bun/releases/download/bun-v1.1.29/${bunUrlSegment}`;
// }

// await $`cp ${bunPath} ${distPath}`;


// others

// await $`cp src/launcher/zig-out/bin/launcher dist/launcher`;
// await $`cp src/extractor/zig-out/bin/extractor dist/extractor`;
// await $`cp src/bsdiff/zig-out/bin/bsdiff dist/bsdiff`;
// await $`cp src/bsdiff/zig-out/bin/bspatch dist/bspatch`;
// await $`cp src/zig/zig-out/bin/webview dist/webview`;





// await $`cp src/cli/build/electrobun dist/electrobun`;
// await $`cp -r src/bun/ dist/api/bun/`;

// await $`cp -r src/browser/ dist/api/browser/`;
// await $`cp -r src/zig/build/libObjcWrapper.dylib dist/libObjcWrapper.dylib`;
// await $`cp -r vendors/cef/Release/Chromium\ Embedded\ Framework.framework dist/Chromium\ Embedded\ Framework.framework`;
// await $`cp -r src/zig/build/process_helper dist/process_helper`;
