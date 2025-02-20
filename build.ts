// Run this script via terminal or command line with bun build.ts

console.log("building...", platform(), arch())

console.log('hi')
import { $ } from "bun";
import { platform, arch } from "os";
import { join } from 'path';
import { existsSync } from "fs";
import {parseArgs} from 'util';

const {values: args} = parseArgs({
    args: Bun.argv,
    options: {
        release: {
            type: 'boolean' 
        }
    },
    allowPositionals: true,
})

// TODO: set via cl arg
const CHANNEL: 'debug' | 'release' = args.release ? 'release' : 'debug';
const OS: 'win' | 'linux' | 'macos' = getPlatform();
const ARCH: 'arm64' | 'x64' = getArch();

const isWindows = platform() === "win32";
const binExt = OS === 'win' ? '.exe' : '';
const bunBin = isWindows ? "bun.exe" : "bun";
const zigBinary = OS === 'win' ? 'zig.exe' : 'zig';

// Note: We want all binaries in /dist to be extensionless to simplify our cross platform code
// (no .exe on windows)

// PATHS
const PATH = {
    bun: {
        RUNTIME: join(process.cwd(), "vendors", "bun", bunBin),
        DIST: join(process.cwd(), "dist", bunBin)
    },
    zig: {
        BIN: join(process.cwd(),'vendors','zig', zigBinary )
    }
}




// TODO: setup file watchers
try {
await setup();
await build();
await copyToDist();
} catch (err) {
    console.log(err);
}

async function setup() {
    await Promise.all([
        vendorBun(),
        vendorZig(),
        vendorCEF(),
        vendorWebview2(),
    ]);
}

async function build() {
    await createDistFolder();
    await BunInstall();

    await buildNative(); // zig depends on this for linking symbols
    await Promise.all([
        buildZig(),
        buildTRDiff(),
        buildSelfExtractor(),
        buildLauncher(),
        buildCli(),
      
    ]);
}


async function copyToDist() {
    // Bun runtime
    await $`cp ${PATH.bun.RUNTIME} ${PATH.bun.DIST}`;
    // Zig
    await $`cp src/launcher/zig-out/bin/launcher${binExt} dist/launcher${binExt}`;
    await $`cp src/extractor/zig-out/bin/extractor${binExt} dist/extractor${binExt}`;
    await $`cp src/bsdiff/zig-out/bin/bsdiff${binExt} dist/bsdiff${binExt}`;
    await $`cp src/bsdiff/zig-out/bin/bspatch${binExt} dist/bspatch${binExt}`;
    await $`cp src/zig/zig-out/bin/webview${binExt} dist/webview${binExt}`;
    // Electrobun cli and npm launcher
    await $`cp src/npmbin/index.js dist/npmbin.js`;
    await $`cp src/cli/build/electrobun${binExt} dist/electrobun${binExt}`;
    // Electrobun's Typescript bun and browser apis
    await $`cp -R src/bun/ dist/api/bun/`;
    await $`cp -R src/browser/ dist/api/browser/`;
    // Native code and frameworks
    if (OS === 'macos') {
        await $`cp -R src/zig/build/libNativeWrapper.dylib dist/libNativeWrapper.dylib`;
        await $`cp -R vendors/cef/Release/Chromium\ Embedded\ Framework.framework dist/Chromium\ Embedded\ Framework.framework`;
        // CEF's helper process binary
        await $`cp -R src/zig/build/process_helper dist/process_helper`;
    } else if (OS === 'win') {
        await $`cp src/zig/build/nativeWrapper.dll dist/nativeWrapper.dll`;
    } else if (OS === 'linux') {

    }
}



function getPlatform() {
    switch (platform()) {
        case "win32":
            return 'win';
        case "darwin":
            return 'macos';
        case 'linux':
            return 'linux';
        default:
            throw 'unsupported platform';
    }
}

function getArch() {
    switch (arch()) {
        case "arm64":
            return 'arm64';
        case "x64":
            return 'x64';
        default:
            throw 'unsupported arch'
    }
}




async function createDistFolder() {
    await $`rm -r dist`.catch(() => { });
    await $`mkdir -p dist/api`;
    await $`mkdir -p dist/api/bun`;
    await $`mkdir -p dist/api/browser`;
}

async function BunInstall() {
    await $`bun install`;
}


async function vendorBun() {
    if (existsSync(PATH.bun.RUNTIME)) {
        return;
    }

    const bunUrlSegment = isWindows ? 'bun-windows-x64.zip' : 'bun-darwin-aarch64.zip';
    const tempZipPath = join("vendors", "bun", "temp.zip");
    
    // Download zip file
    await $`mkdir -p ${join("vendors", "bun")} && curl -L -o ${tempZipPath} https://github.com/oven-sh/bun/releases/download/bun-v1.1.29/${bunUrlSegment}`;
    
    // Extract zip file
    await $`unzip -o ${tempZipPath} -d ${join("vendors", "bun")}`;
    
    // Move the bun binary to the correct location
    // The path inside the zip might be different depending on the platform
    if (isWindows) {
        await $`mv ${join("vendors", "bun", "bun-windows-x64", "bun.exe")} ${PATH.bun.RUNTIME}`;
    } else {
        await $`mv ${join("vendors", "bun", "bun-darwin-aarch64", "bun")} ${PATH.bun.RUNTIME}`;
    }
    
    // Add execute permissions on non-Windows platforms
    if (!isWindows) {
        await $`chmod +x ${PATH.bun.RUNTIME}`;
    }
    
    // Clean up
    await $`rm ${tempZipPath}`;
    await $`rm -rf ${join("vendors", "bun", isWindows ? "bun-windows-x64" : "bun-darwin-aarch64")}`;
}

async function vendorZig() {
    if (existsSync(PATH.zig.BIN)) {
        return;
    }

    if (OS === 'macos') {
        await $`mkdir -p vendors/zig && curl -L https://ziglang.org/download/0.13.0/zig-macos-aarch64-0.13.0.tar.xz | tar -xJ --strip-components=1 -C vendors/zig zig-macos-aarch64-0.13.0/zig zig-macos-aarch64-0.13.0/lib  zig-macos-aarch64-0.13.0/doc`;
    } else if (OS === 'win') {
        await $`mkdir -p vendors/zig && curl -L https://ziglang.org/download/0.13.0/zig-windows-aarch64-0.13.0.zip -o vendors/zig.zip && powershell -ExecutionPolicy Bypass -Command Expand-Archive -Path vendors/zig.zip -DestinationPath vendors/zig-temp && mv vendors/zig-temp/zig-windows-aarch64-0.13.0/zig.exe vendors/zig && mv vendors/zig-temp/zig-windows-aarch64-0.13.0/lib vendors/zig/`;
    }
}

async function vendorCEF() {
    if (existsSync(join(process.cwd(), 'vendors', 'cef'))) {
        return;
    }

    if (OS === 'macos') {
        // download
        await $`cd vendors/cef && rm -rf build && mkdir -p build && cd build && cmake -DPROJECT_ARCH=\"arm64\" -DCMAKE_BUILD_TYPE=Release .. && make -j8 libcef_dll_wrapper`;
        // build
        await $`clang++ -mmacosx-version-min=10.13 -std=c++17 -ObjC++ -fobjc-arc -I./vendors/cef -c src/objc/cef_process_helper_mac.cc -o src/objc/build/process_helper_mac.o`;
        // link
        await $`clang++ -mmacosx-version-min=10.13 -std=c++17 src/objc/build/process_helper_mac.o -o src/zig/build/process_helper -framework Cocoa -framework WebKit -framework QuartzCore -F./vendors/cef/Release -framework \"Chromium Embedded Framework\" -L./vendors/cef/build/libcef_dll_wrapper -lcef_dll_wrapper -stdlib=libc++`;
        // fix internal path
        await $`install_name_tool -change \"@executable_path/../Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework\" \"@executable_path/../../../../Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework\" src/zig/build/process_helper`;
    } else if (OS === 'win') {

    }
}

async function vendorNuget() {
    if (OS === 'win') {
        if (existsSync(join(process.cwd(), 'vendors', 'nuget', 'nuget.exe'))) {
            return;
        }

        // install nuget package manager
        await $`mkdir -p vendors/nuget && curl -L -o vendors/nuget/nuget.exe https://dist.nuget.org/win-x86-commandline/latest/nuget.exe`;
    }
}

async function vendorWebview2() {
    if (OS === 'win') {
        if (existsSync(join(process.cwd(), 'vendors', 'webview2'))) {
            return;
        }

        await vendorNuget();

        // install nuget package manager
        await $`vendors/nuget/nuget.exe install Microsoft.Web.WebView2 -OutputDirectory vendors/webview2`;
    }
}

async function buildTRDiff() {

    if (CHANNEL === 'debug') {
        await $`cd src/bsdiff && ../../vendors/zig/zig build`;
    } else {
        await $`cd src/bsdiff && ../../vendors/zig/zig build -Doptimize=ReleaseFast`;
    }
}

async function buildNative() {
    if (OS === 'macos') {
        await $`mkdir -p src/native/macos/build && clang++ -c src/native/macos/nativeWrapper.mm -o src/native/macos/build/nativeWrapper.o -fobjc-arc -fno-objc-msgsend-selector-stubs -I./vendors/cef -std=c++17`;
        await $`mkdir -p src/zig/build && clang++ -o src/zig/build/libNativeWrapper.dylib src/native/macos/build/nativeWrapper.o -framework Cocoa -framework WebKit -framework QuartzCore -F./vendors/cef/Release -weak_framework 'Chromium Embedded Framework' -L./vendors/cef/build/libcef_dll_wrapper -lcef_dll_wrapper -stdlib=libc++ -shared -install_name @executable_path/libNativeWrapper.dylib`;
    } else if (OS === 'win') {
        await $`mkdir -p src/native/win/build && cl /c /D_USRDLL /D_WINDLL /Fosrc/native/win/build/nativeWrapper.obj src/native/win/nativeWrapper.cpp`;
        await $`link /DLL /OUT:src/zig/build/nativeWrapper.dll /IMPLIB:src/zig/build/nativeWrapper.lib src/native/win/build/nativeWrapper.obj`;
    } else if (OS === 'linux') {

    }
}

async function buildZig() {
    
    if (CHANNEL === 'debug') {
        await $`cd src/zig && ../../vendors/zig/${zigBinary} build`;
    } else if (CHANNEL === 'release') {
        await $`cd src/zig && ../../vendors/zig/${zigBinary} build -Doptimize=ReleaseFast`;
    }
}

async function buildLauncher() {
    if (CHANNEL === 'debug') {
        await $`cd src/launcher && ../../vendors/zig/zig build`;
    } else if (CHANNEL === 'release') {
        await $`cd src/launcher && ../../vendors/zig/zig build -Doptimize=ReleaseSmall`;
    }
}

async function buildSelfExtractor() {
    if (CHANNEL === 'debug') {
        await $`cd src/extractor && ../../vendors/zig/zig build`;
    } else if (CHANNEL === 'release') {
        await $`cd src/extractor && ../../vendors/zig/zig build -Doptimize=ReleaseSmall`;
    }
}

async function buildCli() {

    await $`bun build src/cli/index.ts --compile --outfile src/cli/build/electrobun`;

}

