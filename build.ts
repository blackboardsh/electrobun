// Run this script via terminal or command line with bun build.ts

import { $ } from "bun";
import { platform, arch } from "os";
import { join } from 'path';
import { existsSync, readdirSync, renameSync } from "fs";
import { parseArgs } from 'util';
import process from 'process';

console.log("building...", platform(), arch())

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
        buildTRDiff(),
        buildSelfExtractor(),
        buildLauncher(),
        buildCli(),
        buildMainJs(),
      
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
    // Electrobun cli and npm launcher
    await $`cp src/npmbin/index.js dist/npmbin.js`;
    await $`cp src/cli/build/electrobun${binExt} dist/electrobun${binExt}`;    
    // Electrobun's Typescript bun and browser apis
    if (OS === 'win') {
        // on windows the folder gets copied "into" the detination folder
        await $`cp -R src/bun/ dist/api`;
        await $`cp -R src/browser/ dist/api`;
    } else {
        // on unix cp is more like a rename        
        await $`cp -R src/bun/ dist/api/bun`;
        await $`cp -R src/browser/ dist/api/browser`; 
    }
    // Native code and frameworks
    if (OS === 'macos') {
        await $`cp -R src/native/build/libNativeWrapper.dylib dist/libNativeWrapper.dylib`;
        await $`cp -R vendors/cef/Release/Chromium\ Embedded\ Framework.framework dist/Chromium\ Embedded\ Framework.framework`;
        // CEF's helper process binary
        await $`cp -R src/native/build/process_helper dist/process_helper`;
    } else if (OS === 'win') {
        await $`cp src/native/win/build/libNativeWrapper.dll dist/libNativeWrapper.dll`;
        // native system webview library
        await $`cp vendors/webview2/Microsoft.Web.WebView2/build/native/x64/WebView2Loader.dll dist/WebView2Loader.dll`;
        // CEF binaries for Windows - copy ALL CEF files to cef/ subdirectory for consistent organization
        // Copy main CEF DLLs to cef/ subdirectory
        await $`powershell -command "if (Test-Path 'vendors/cef/Release/*.dll') { Copy-Item 'vendors/cef/Release/*.dll' 'dist/cef/' -Force }"`;
        
        // Copy all available resource files to cef/ subdirectory
        await $`powershell -command "if (Test-Path 'vendors/cef/Release/*.pak') { Copy-Item 'vendors/cef/Release/*.pak' 'dist/cef/' -Force }"`;
        await $`powershell -command "if (Test-Path 'vendors/cef/Release/*.dat') { Copy-Item 'vendors/cef/Release/*.dat' 'dist/cef/' -Force }"`;
        await $`powershell -command "if (Test-Path 'vendors/cef/Release/*.bin') { Copy-Item 'vendors/cef/Release/*.bin' 'dist/cef/' -Force }"`;
        
        // Copy icudtl.dat directly to cef/ root (same folder as DLLs) - this is required for CEF initialization
        await $`powershell -command "if (Test-Path 'vendors/cef/Resources/icudtl.dat') { Copy-Item 'vendors/cef/Resources/icudtl.dat' 'dist/cef/' -Force }"`.catch(() => {});
        
        // CEF locales to cef/Resources/locales subdirectory 
        await $`powershell -command "if (-not (Test-Path 'dist/cef/Resources')) { New-Item -ItemType Directory -Path 'dist/cef/Resources' -Force | Out-Null }"`;
        await $`powershell -command "if (Test-Path 'vendors/cef/Resources/locales') { Copy-Item 'vendors/cef/Resources/locales' 'dist/cef/Resources/' -Recurse -Force }"`.catch(() => {});
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
    if (OS === 'win') {
        await $`mkdir -p dist/cef`;
    }
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
    const extractDir = join("vendors", "bun");
    
    // Download zip file
    await $`mkdir -p ${extractDir} && curl -L -o ${tempZipPath} https://github.com/oven-sh/bun/releases/download/bun-v1.2.2/${bunUrlSegment}`;
    
    // Extract zip file
    // await $`unzip -o ${tempZipPath} -d ${join("vendors", "bun")}`;
    if (isWindows) {
        // Use PowerShell to extract zip on Windows
        await $`powershell -command "Expand-Archive -Path ${tempZipPath} -DestinationPath ${extractDir} -Force"`;
      } else {
        // Use unzip on macOS/Linux
        await $`unzip -o ${tempZipPath} -d ${extractDir}`;
      }
    
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
    // Use stable CEF version for macOS, current for Windows
    const CEF_VERSION_MAC = `125.0.22+g4b2c969`;
    const CHROMIUM_VERSION_MAC = `125.0.6422.142`;
    const CEF_VERSION_WIN = `138.0.17+gac9b751`;
    const CHROMIUM_VERSION_WIN = `138.0.7204.97`;
    
    if (OS === 'macos') {
        if (!existsSync(join(process.cwd(), 'vendors', 'cef'))) {                
            await $`mkdir -p vendors/cef && curl -L "https://cef-builds.spotifycdn.com/cef_binary_${CEF_VERSION_MAC}%2Bchromium-${CHROMIUM_VERSION_MAC}_macosarm64_minimal.tar.bz2" | tar -xj --strip-components=1 -C vendors/cef`;                                                                                                                                        
        }
        
        // Build process_helper binary
        if (!existsSync(join(process.cwd(), 'src', 'native', 'build', 'process_helper'))) {                
            await $`mkdir -p src/native/build`;
            // build
            await $`cd vendors/cef && rm -rf build && mkdir -p build && cd build && cmake -DPROJECT_ARCH="arm64" -DCMAKE_BUILD_TYPE=Release .. && make -j8 libcef_dll_wrapper`;
            // build
            await $`clang++ -mmacosx-version-min=10.13 -std=c++17 -ObjC++ -fobjc-arc -I./vendors/cef -c src/native/macos/cef_process_helper_mac.cc -o src/native/build/process_helper_mac.o`;
            // link
            await $`clang++ -mmacosx-version-min=10.13 -std=c++17 src/native/build/process_helper_mac.o -o src/native/build/process_helper -framework Cocoa -framework WebKit -framework QuartzCore -F./vendors/cef/Release -framework "Chromium Embedded Framework" -L./vendors/cef/build/libcef_dll_wrapper -lcef_dll_wrapper -stdlib=libc++`;
            // fix internal path
            // Note: Can use `otool -L src/native/build/process_helper` to check the value            
            await $`install_name_tool -change "@executable_path/../Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework" "@executable_path/../../../../Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework" src/native/build/process_helper`;            
        }
    } else if (OS === 'win') {
        if (!existsSync(join(process.cwd(), 'vendors', 'cef'))) {
            // Download Windows CEF binaries (minimal distribution)
            const tempPath = join(process.cwd(), 'vendors', 'cef_temp.tar.bz2');
            // Create vendors directory if needed
            await $`powershell -command "if (-not (Test-Path vendors)) { New-Item -ItemType Directory -Path vendors | Out-Null }"`;
            
            // Download CEF - using URL encoding for the + character
            console.log('Downloading CEF binaries...');
            await $`curl -L "https://cef-builds.spotifycdn.com/cef_binary_${CEF_VERSION_WIN}%2Bchromium-${CHROMIUM_VERSION_WIN}_windows64_minimal.tar.bz2" -o "${tempPath}"`;
            
            // Verify download completed
            if (!existsSync(tempPath)) {
                throw new Error('Download failed - file not found');
            }
            
            const { statSync } = await import('fs');
            const stats = statSync(tempPath);
            console.log(`Downloaded file size: ${stats.size} bytes`);
            
            if (stats.size < 1000000) { // Less than 1MB indicates failed download
                throw new Error(`Download failed - file too small: ${stats.size} bytes`);
            }
            
            // Extract using tar (Windows 10+ has built-in tar support)
            console.log('Extracting CEF...');
            await $`powershell -command "New-Item -ItemType Directory -Path 'vendors/cef_temp' -Force | Out-Null"`;
            await $`powershell -command "New-Item -ItemType Directory -Path 'vendors/cef' -Force | Out-Null"`;
            
            // Extract tar.bz2 using Windows built-in tar
            console.log('Extracting with tar...');
            await $`tar -xjf "${tempPath}" -C vendors/cef_temp`;
            
            // Check what was extracted
            const tempDir = 'vendors/cef_temp';
            console.log('Checking extracted contents...');
            
            if (!existsSync(tempDir)) {
                throw new Error('Temp extraction directory not created');
            }
            
            const extractedDirs = readdirSync(tempDir);
            console.log('Extracted directories:', extractedDirs);
            
            if (extractedDirs.length === 0) {
                throw new Error('No files extracted');
            }
            
            // Move the contents from the extracted directory
            const extractedPath = join(tempDir, extractedDirs[0]);
            console.log('Moving files from:', extractedPath);
            
            if (existsSync(extractedPath)) {
                // Use PowerShell Copy-Item for reliable directory copying
                await $`powershell -command "Copy-Item -Path '${extractedPath}\\*' -Destination 'vendors\\cef' -Recurse -Force"`;
            } else {
                // If it's not a directory, the files might be directly in cef_temp
                await $`powershell -command "Copy-Item -Path 'vendors\\cef_temp\\*' -Destination 'vendors\\cef' -Recurse -Force"`;
            }
            
            // Clean up temp directory
            await $`powershell -command "Remove-Item 'vendors/cef_temp' -Recurse -Force"`;
            
            // Clean up temp file
            await $`powershell -command "Remove-Item '${tempPath}' -Force"`;
            
            // Verify extraction worked
            const cefCMakeFile = join(process.cwd(), 'vendors', 'cef', 'CMakeLists.txt');
            if (!existsSync(cefCMakeFile)) {
                throw new Error('CEF extraction failed - CMakeLists.txt not found');
            }
            console.log('CEF extracted successfully');
        }
        
        // Build CEF wrapper library for Windows
        if (!existsSync(join(process.cwd(), 'vendors', 'cef', 'build', 'libcef_dll_wrapper', 'Release', 'libcef_dll_wrapper.lib'))) {
            // Clean and create build directory
            await $`cd vendors/cef && powershell -command "if (Test-Path build) { Remove-Item -Recurse -Force build }"`;
            await $`cd vendors/cef && mkdir build`;
            // Generate Visual Studio project with sandbox disabled
            await $`cd vendors/cef/build && cmake -G "Visual Studio 17 2022" -A x64 -DCEF_USE_SANDBOX=OFF -DCMAKE_BUILD_TYPE=Release ..`;
            // Build the wrapper library only
            await $`cd vendors/cef/build && msbuild cef.sln /p:Configuration=Release /p:Platform=x64 /target:libcef_dll_wrapper`;
        }
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

        const webview2BasePath = './vendors/webview2';
        const webview2Dir = readdirSync(webview2BasePath).find((dir: string) => dir.startsWith('Microsoft.Web.WebView2'));

        if (webview2Dir && webview2Dir !== 'Microsoft.Web.WebView2') {
            const oldPath = join(webview2BasePath, webview2Dir);
            const newPath = join(webview2BasePath, 'Microsoft.Web.WebView2');
            
            try {
                renameSync(oldPath, newPath);
                console.log(`Renamed ${webview2Dir} to Microsoft.Web.WebView2`);
            } catch (error) {
                console.error('Error renaming folder:', error);
            }
        }
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
        await $`mkdir -p src/native/build && clang++ -o src/native/build/libNativeWrapper.dylib src/native/macos/build/nativeWrapper.o -framework Cocoa -framework WebKit -framework QuartzCore -F./vendors/cef/Release -weak_framework 'Chromium Embedded Framework' -L./vendors/cef/build/libcef_dll_wrapper -lcef_dll_wrapper -stdlib=libc++ -shared -install_name @executable_path/libNativeWrapper.dylib`;
    } else if (OS === 'win') {
        const webview2Include = `./vendors/webview2/Microsoft.Web.WebView2/build/native/include`;
        const webview2Lib = `./vendors/webview2/Microsoft.Web.WebView2/build/native/x64/WebView2LoaderStatic.lib`;
        const cefInclude = `./vendors/cef`;
        const cefLib = `./vendors/cef/Release/libcef.lib`;
        const cefWrapperLib = `./vendors/cef/build/libcef_dll_wrapper/Release/libcef_dll_wrapper.lib`;

        // Compile the main wrapper with both WebView2 and CEF support (runtime detection)
        await $`mkdir -p src/native/win/build && cl /c /EHsc /std:c++17 /I"${webview2Include}" /I"${cefInclude}" /D_USRDLL /D_WINDLL /Fosrc/native/win/build/nativeWrapper.obj src/native/win/nativeWrapper.cpp`;

        // Link with both WebView2 and CEF libraries
        await $`link /DLL /OUT:src/native/win/build/libNativeWrapper.dll user32.lib ole32.lib shell32.lib shlwapi.lib advapi32.lib dcomp.lib d2d1.lib "${webview2Lib}" "${cefLib}" "${cefWrapperLib}" /IMPLIB:src/native/win/build/libNativeWrapper.lib src/native/win/build/nativeWrapper.obj`;
    } else if (OS === 'linux') {

    }
}

async function buildLauncher() {
    if (CHANNEL === 'debug') {
        await $`cd src/launcher && ../../vendors/zig/zig build`;
    } else if (CHANNEL === 'release') {
        await $`cd src/launcher && ../../vendors/zig/zig build -Doptimize=ReleaseSmall`;
    }
}

async function buildMainJs() {
    const bunModule = await import('bun');
    return await bunModule.build({
        entrypoints: [join('src', 'launcher', 'main.ts')],
        outdir: join('dist'),
        external: [],
        // minify: true, // todo (yoav): add minify in canary and prod builds
        target: "bun",
      });
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

