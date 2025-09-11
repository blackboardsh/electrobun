// Run this script via terminal or command line with bun build.ts

import { $ } from 'bun';
import { execSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { arch, platform } from 'os';
import { dirname, join, relative } from 'path';
import process from 'process';
import { parseArgs } from 'util';

console.log('building...', platform(), arch());

const { values: args } = parseArgs({
  args: Bun.argv,
  options: {
    release: {
      type: 'boolean',
    },
    ci: {
      type: 'boolean',
    },
    npm: {
      type: 'boolean',
    },
  },
  allowPositionals: true,
});

// TODO: set via cl arg
const CHANNEL: 'debug' | 'release' = args.release ? 'release' : 'debug';
const IS_CI = args.ci || false;
const IS_NPM_BUILD = args.npm || false;
const OS: 'win' | 'linux' | 'macos' = getPlatform();
const ARCH: 'arm64' | 'x64' = getArch();

const isWindows = platform() === 'win32';
const binExt = OS === 'win' ? '.exe' : '';
const bunBin = isWindows ? 'bun.exe' : 'bun';
const zigBinary = OS === 'win' ? 'zig.exe' : 'zig';

// Note: We want all binaries in /dist to be extensionless to simplify our cross platform code
// (no .exe on windows)

// PATHS
const PATH = {
  bun: {
    RUNTIME: join(process.cwd(), 'vendors', 'bun', bunBin),
    DIST: join(process.cwd(), 'dist', bunBin),
  },
  zig: {
    BIN: join(process.cwd(), 'vendors', 'zig', zigBinary),
  },
};

// TODO: setup file watchers
try {
  if (IS_NPM_BUILD) {
    console.log('Building for npm (JS/TS files only)...');
    await buildForNpm();
  } else {
    await setup();
    await build();
    await copyToDist();
  }
} catch (err) {
  console.log(err);
}

// Global variable to store cmake path
var CMAKE_BIN = 'cmake';

async function vendorCmake() {
  if (OS !== 'macos') return;

  // On macOS, cmake is distributed as an app bundle
  const vendoredCmakePath = join(
    process.cwd(),
    'vendors',
    'cmake',
    'CMake.app',
    'Contents',
    'bin',
    'cmake'
  );

  // Check if cmake is already available (system or vendored)
  try {
    await $`which cmake`.quiet();
    console.log('✓ cmake found in system PATH');
    CMAKE_BIN = 'cmake';
    return;
  } catch {
    // Not in system PATH, check if vendored
    if (existsSync(vendoredCmakePath)) {
      CMAKE_BIN = vendoredCmakePath;
      console.log('✓ Using vendored cmake');
      return;
    }
  }

  console.log('cmake not found, downloading...');

  try {
    const cmakeVersion = '3.30.2';
    const cmakeUrl = `https://github.com/Kitware/CMake/releases/download/v${cmakeVersion}/cmake-${cmakeVersion}-macos-universal.tar.gz`;

    await $`mkdir -p vendors`;
    console.log(`Downloading cmake ${cmakeVersion} for macOS...`);

    // Download and extract in vendors directory
    const tempFile = 'vendors/cmake_temp.tar.gz';
    await $`curl -L "${cmakeUrl}" -o "${tempFile}"`;

    // Extract in vendors directory
    await $`cd vendors && tar -xzf cmake_temp.tar.gz`;

    // Always clean up the temp file
    await $`rm -f vendors/cmake_temp.tar.gz`;

    // Rename to simple 'cmake' directory if needed
    const extractedDir = `vendors/cmake-${cmakeVersion}-macos-universal`;
    if (existsSync(extractedDir)) {
      await $`rm -rf vendors/cmake`; // Remove old cmake if exists
      await $`mv "${extractedDir}" vendors/cmake`;
    }

    // Set the cmake binary path
    CMAKE_BIN = vendoredCmakePath;

    // Verify it works
    await $`"${CMAKE_BIN}" --version`;
    console.log('✓ cmake vendored successfully');
  } catch (error) {
    console.error('Failed to vendor cmake:', error);
    throw new Error('Could not vendor cmake. Please install it manually.');
  }
}

async function checkDependencies() {
  const missingDeps = [];

  if (OS === 'macos') {
    // Try to vendor cmake if not available
    await vendorCmake();

    // Check for make (should be available with Xcode command line tools)
    try {
      await $`which make`.quiet();
    } catch {
      missingDeps.push(
        'make (install Xcode Command Line Tools: xcode-select --install)'
      );
    }
  } else if (OS === 'win') {
    // Check for Visual Studio / MSBuild
    try {
      await $`where cmake`.quiet();
      CMAKE_BIN = 'cmake';
    } catch {
      missingDeps.push('cmake');
    }
  } else if (OS === 'linux') {
    // Check for build essentials
    try {
      await $`which cmake`.quiet();
      CMAKE_BIN = 'cmake';
    } catch {
      missingDeps.push('cmake');
    }
    try {
      await $`which make`.quiet();
    } catch {
      missingDeps.push('make');
    }
    try {
      await $`which gcc`.quiet();
    } catch {
      missingDeps.push('build-essential');
    }
  }

  if (missingDeps.length > 0) {
    console.error('\n⚠️  Missing required dependencies:');
    missingDeps.forEach((dep) => console.error(`  • ${dep}`));

    if (OS === 'macos') {
      console.error('\nTo install missing dependencies on macOS:');
      console.error('• For make: Install Xcode Command Line Tools');
      console.error('   xcode-select --install');
    } else if (OS === 'win') {
      console.error('\nTo install missing dependencies on Windows:');
      console.error('1. Install Visual Studio (or Build Tools) with C++ development tools');
      console.error('2. Install cmake from: https://cmake.org/download/');
    } else if (OS === 'linux') {
      console.error('\nTo install missing dependencies on Linux:');
      console.error(
        '   sudo apt update && sudo apt install -y build-essential cmake'
      );
    }

    throw new Error(
      'Missing required dependencies. Please install them and try again.'
    );
  }

  console.log('✓ All required dependencies found');
}

async function setup() {
  await checkDependencies();
  await Promise.all([
    vendorBun(),
    vendorZig(),
    vendorCEF(),
    vendorWebview2(),
    vendorLinuxDeps(),
  ]);
}

async function build() {
  await createDistFolder();
  await BunInstall();

  await buildNative(); // zig depends on this for linking symbols

  // Generate template embeddings before building CLI
  console.log('Generating template embeddings...');
  await generateTemplateEmbeddings();

  await Promise.all([
    buildTRDiff(),
    buildSelfExtractor(),
    buildLauncher(),
    buildCli(),
    buildMainJs(),
  ]);
}

async function buildForNpm() {
  console.log('Creating dist folder for npm...');
  await createDistFolder();

  console.log('Building main.js...');
  await buildMainJs();

  console.log('Copying API files...');
  await copyApiFiles();

  console.log(
    'npm build complete! dist/ contains main.js and api/ folder (bun, browser, shared APIs).'
  );
}

async function copyApiFiles() {
  // Copy TypeScript APIs (src/bun, src/browser, and src/shared to dist/api/)
  if (OS === 'win') {
    // on windows the folder gets copied "into" the destination folder
    await $`cp -R src/bun/ dist/api`;
    await $`cp -R src/browser/ dist/api`;
    await $`cp -R src/shared/ dist/api`;
  } else {
    // on unix cp is more like a rename
    await $`cp -R src/bun dist/api/`;
    await $`cp -R src/browser dist/api/`;
    await $`cp -R src/shared dist/api/`;
  }
}

async function copyToDist() {
  // Bun runtime
  await $`cp ${PATH.bun.RUNTIME} ${PATH.bun.DIST}`;
  // Zig
  await $`cp src/launcher/zig-out/bin/launcher${binExt} dist/launcher${binExt}`;
  await $`cp src/extractor/zig-out/bin/extractor${binExt} dist/extractor${binExt}`;
  await $`cp src/bsdiff/zig-out/bin/bsdiff${binExt} dist/bsdiff${binExt}`;
  await $`cp src/bsdiff/zig-out/bin/bspatch${binExt} dist/bspatch${binExt}`;

  // Verify critical files were copied
  const launcherPath = join('dist', `launcher${binExt}`);
  if (!existsSync(launcherPath)) {
    throw new Error(`launcher${binExt} was not copied to ${launcherPath}`);
  }
  console.log(`launcher${binExt} copied successfully to ${launcherPath}`);
  // Electrobun cli and npm launcher
  await $`cp src/npmbin/index.js dist/npmbin.js`;
  await $`cp src/cli/build/electrobun${binExt} dist/electrobun${binExt}`;
  // Electrobun's Typescript bun and browser apis
  await copyApiFiles();
  // Native code and frameworks
  if (OS === 'macos') {
    await $`cp -R src/native/build/libNativeWrapper.dylib dist/libNativeWrapper.dylib`;
    // Copy CEF to cef/ subdirectory for consistent organization
    await $`mkdir -p dist/cef`;
    await $`cp -R vendors/cef/Release/Chromium\ Embedded\ Framework.framework dist/cef/Chromium\ Embedded\ Framework.framework`;
    // CEF's helper process binary
    await $`cp -R src/native/build/process_helper dist/cef/process_helper`;
  } else if (OS === 'win') {
    await $`cp src/native/win/build/libNativeWrapper.dll dist/libNativeWrapper.dll`;
    // native system webview library - always use x64 for Windows
    const webview2Arch = 'x64';
    await $`cp vendors/webview2/Microsoft.Web.WebView2/build/native/${webview2Arch}/WebView2Loader.dll dist/WebView2Loader.dll`;
    // CEF binaries for Windows - copy ALL CEF files to cef/ subdirectory for consistent organization
    await $`powershell -command "New-Item -ItemType Directory -Path 'dist/cef' -Force | Out-Null"`;
    // Copy main CEF DLLs to cef/ subdirectory
    await $`powershell -command "if (Test-Path 'vendors/cef/Release/*.dll') { Copy-Item 'vendors/cef/Release/*.dll' 'dist/cef/' -Force }"`;

    // Copy all available resource files to cef/ subdirectory from both Release and Resources directories
    console.log('Copying CEF resource files...');

    // Copy .pak files from Resources directory
    await $`powershell -command "if (Test-Path 'vendors/cef/Resources/*.pak') { Write-Host 'Found .pak files in Resources, copying...'; Copy-Item 'vendors/cef/Resources/*.pak' 'dist/cef/' -Force } else { Write-Host 'No .pak files found in vendors/cef/Resources/' }"`;

    // Copy resource files from Release directory
    await $`powershell -command "if (Test-Path 'vendors/cef/Release/*.pak') { Write-Host 'Found .pak files in Release, copying...'; Copy-Item 'vendors/cef/Release/*.pak' 'dist/cef/' -Force }"`;
    await $`powershell -command "if (Test-Path 'vendors/cef/Release/*.dat') { Copy-Item 'vendors/cef/Release/*.dat' 'dist/cef/' -Force }"`;
    await $`powershell -command "if (Test-Path 'vendors/cef/Release/*.bin') { Copy-Item 'vendors/cef/Release/*.bin' 'dist/cef/' -Force }"`;

    // Copy icudtl.dat directly to cef/ root (same folder as DLLs) - this is required for CEF initialization
    await $`powershell -command "if (Test-Path 'vendors/cef/Resources/icudtl.dat') { Copy-Item 'vendors/cef/Resources/icudtl.dat' 'dist/cef/' -Force }"`.catch(
      () => {}
    );

    // CEF locales to cef/Resources/locales subdirectory
    await $`powershell -command "if (-not (Test-Path 'dist/cef/Resources')) { New-Item -ItemType Directory -Path 'dist/cef/Resources' -Force | Out-Null }"`;
    await $`powershell -command "if (Test-Path 'vendors/cef/Resources/locales') { Copy-Item 'vendors/cef/Resources/locales' 'dist/cef/Resources/' -Recurse -Force }"`.catch(
      () => {}
    );

    // Copy CEF helper process
    await $`cp src/native/build/process_helper.exe dist/cef/process_helper.exe`;
  } else if (OS === 'linux') {
    // Copy both GTK-only and CEF native wrappers for flexible deployment
    if (
      existsSync(
        join(process.cwd(), 'src', 'native', 'build', 'libNativeWrapper.so')
      )
    ) {
      await $`cp src/native/build/libNativeWrapper.so dist/libNativeWrapper.so`;
    }
    if (
      existsSync(
        join(process.cwd(), 'src', 'native', 'build', 'libNativeWrapper_cef.so')
      )
    ) {
      await $`cp src/native/build/libNativeWrapper_cef.so dist/libNativeWrapper_cef.so`;
    }

    // CEF binaries for Linux - copy to cef/ subdirectory
    if (existsSync(join(process.cwd(), 'vendors', 'cef', 'Release'))) {
      console.log('Copying CEF files for Linux...');
      await $`mkdir -p dist/cef`;

      // Copy main CEF library and dependencies
      await $`cp vendors/cef/Release/*.so dist/cef/`;
      await $`cp vendors/cef/Release/*.so.* dist/cef/`; // For versioned libraries like libvulkan.so.1
      await $`cp vendors/cef/Release/*.bin dist/cef/`;
      await $`cp vendors/cef/Release/*.json dist/cef/`; // For vk_swiftshader_icd.json

      // Strip debug symbols from CEF libraries to reduce file size
      console.log('Stripping debug symbols from CEF libraries...');
      await $`strip --strip-debug dist/cef/*.so dist/cef/*.so.* 2>/dev/null || true`;

      // Copy stripped CEF files to platform-specific directory
      const platformCefDir = `dist-${OS}-${ARCH}/cef`;
      await $`mkdir -p ${platformCefDir}`;
      await $`cp -r dist/cef/* ${platformCefDir}/`;
      console.log(`Copied stripped CEF files to ${platformCefDir}`);

      // Copy chrome-sandbox (needs setuid root)
      if (
        existsSync(
          join(process.cwd(), 'vendors', 'cef', 'Release', 'chrome-sandbox')
        )
      ) {
        await $`cp vendors/cef/Release/chrome-sandbox dist/cef/`;
      }

      // Copy Resources
      await $`cp vendors/cef/Resources/*.pak dist/cef/`;
      await $`cp vendors/cef/Resources/*.dat dist/cef/`;

      // Copy locales
      await $`mkdir -p dist/cef/locales`;
      await $`cp vendors/cef/Resources/locales/*.pak dist/cef/locales/`;
    } else {
      console.log('CEF not built, skipping CEF file copying');
    }

    // Copy CEF helper process if it exists
    if (
      existsSync(
        join(process.cwd(), 'src', 'native', 'build', 'process_helper')
      )
    ) {
      await $`cp src/native/build/process_helper dist/cef/process_helper`;
    }
    console.log('[done]Copying CEF files for Linux...');
  }

  // Create platform-specific dist folder and copy all files
  await createPlatformDistFolder();
}

async function createPlatformDistFolder() {
  // Create platform-specific dist folder (e.g., dist-linux-arm64)
  const platformDistDir = `dist-${OS}-${ARCH}`;
  console.log(`Creating platform-specific dist folder: ${platformDistDir}`);

  await $`mkdir -p ${platformDistDir}`;

  // Copy all files from dist/ to platform-specific folder
  if (OS === 'win') {
    // On Windows use PowerShell to copy all files
    await $`powershell -command "Copy-Item -Path 'dist\\*' -Destination '${platformDistDir}\\' -Recurse -Force"`;
  } else {
    // On Unix systems - use rsync with delete to ensure clean copy
    // The --delete flag removes files in destination that don't exist in source
    // This handles read-only files that might prevent overwriting
    await $`rsync -a --delete dist/ ${platformDistDir}/`;
  }

  // NOTE: We no longer remove adhoc signatures from binaries
  // These signatures are actually required for the binaries to run on macOS
  // The notarization issues were fixed by using proper entitlements and not using --deep

  console.log(`Successfully created and populated ${platformDistDir}`);
}

function getPlatform() {
  switch (platform()) {
    case 'win32':
      return 'win';
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      throw 'unsupported platform';
  }
}

function getArch() {
  switch (arch()) {
    case 'arm64':
      return 'arm64';
    case 'x64':
      return 'x64';
    default:
      throw 'unsupported arch';
  }
}

async function createDistFolder() {
  await $`rm -r dist`.catch(() => {});
  await $`mkdir -p dist/api`;
  await $`mkdir -p dist/api/bun`;
  await $`mkdir -p dist/api/browser`;
  if (OS === 'win' || OS === 'linux') {
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

  let bunUrlSegment: string;
  let bunDirName: string;

  if (OS === 'win') {
    // Use baseline x64 for Windows to ensure ARM64 compatibility
    bunUrlSegment = 'bun-windows-x64-baseline.zip';
    bunDirName = 'bun-windows-x64-baseline';
  } else if (OS === 'macos') {
    bunUrlSegment =
      ARCH === 'arm64' ? 'bun-darwin-aarch64.zip' : 'bun-darwin-x64.zip';
    bunDirName = ARCH === 'arm64' ? 'bun-darwin-aarch64' : 'bun-darwin-x64';
  } else if (OS === 'linux') {
    bunUrlSegment =
      ARCH === 'arm64' ? 'bun-linux-aarch64.zip' : 'bun-linux-x64.zip';
    bunDirName = ARCH === 'arm64' ? 'bun-linux-aarch64' : 'bun-linux-x64';
  } else {
    throw new Error(`Unsupported platform: ${OS}`);
  }

  const tempZipPath = join('vendors', 'bun', 'temp.zip');
  const extractDir = join('vendors', 'bun');

  // Download zip file
  await $`mkdir -p ${extractDir} && curl -L -o ${tempZipPath} https://github.com/oven-sh/bun/releases/download/bun-v1.2.2/${bunUrlSegment}`;

  // Extract zip file
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
    await $`mv ${join('vendors', 'bun', bunDirName, 'bun.exe')} ${
      PATH.bun.RUNTIME
    }`;
  } else {
    await $`mv ${join('vendors', 'bun', bunDirName, 'bun')} ${
      PATH.bun.RUNTIME
    }`;
  }

  // Add execute permissions on non-Windows platforms
  if (!isWindows) {
    await $`chmod +x ${PATH.bun.RUNTIME}`;
  }

  // Clean up
  await $`rm ${tempZipPath}`;
  await $`rm -rf ${join('vendors', 'bun', bunDirName)}`;
}

async function vendorZig() {
  if (existsSync(PATH.zig.BIN)) {
    return;
  }

  if (OS === 'macos') {
    const zigArch = ARCH === 'arm64' ? 'aarch64' : 'x86_64';
    await $`mkdir -p vendors/zig && curl -L https://ziglang.org/download/0.13.0/zig-macos-${zigArch}-0.13.0.tar.xz | tar -xJ --strip-components=1 -C vendors/zig zig-macos-${zigArch}-0.13.0/zig zig-macos-${zigArch}-0.13.0/lib  zig-macos-${zigArch}-0.13.0/doc`;
  } else if (OS === 'win') {
    // Always use x64 for Windows since we only build x64 Windows binaries
    const zigArch = 'x86_64';
    const zigFolder = `zig-windows-${zigArch}-0.13.0`;
    await $`mkdir -p vendors/zig`;
    await $`curl -L https://ziglang.org/download/0.13.0/${zigFolder}.zip -o vendors/zig.zip`;
    await $`powershell -ExecutionPolicy Bypass -Command "Expand-Archive -Path 'vendors/zig.zip' -DestinationPath 'vendors/zig-temp' -Force"`;
    await $`powershell -ExecutionPolicy Bypass -Command "Copy-Item 'vendors/zig-temp/${zigFolder}/zig.exe' 'vendors/zig/' -Force"`;
    await $`powershell -ExecutionPolicy Bypass -Command "Copy-Item 'vendors/zig-temp/${zigFolder}/lib' 'vendors/zig/' -Recurse -Force"`;
    await $`powershell -ExecutionPolicy Bypass -Command "Remove-Item 'vendors/zig-temp' -Recurse -Force"`;
    await $`powershell -ExecutionPolicy Bypass -Command "Remove-Item 'vendors/zig.zip' -Force"`;
  } else if (OS === 'linux') {
    const zigArch = ARCH === 'arm64' ? 'aarch64' : 'x86_64';
    await $`mkdir -p vendors/zig && curl -L https://ziglang.org/download/0.13.0/zig-linux-${zigArch}-0.13.0.tar.xz | tar -xJ --strip-components=1 -C vendors/zig zig-linux-${zigArch}-0.13.0/zig zig-linux-${zigArch}-0.13.0/lib zig-linux-${zigArch}-0.13.0/doc`;
  }
}

async function vendorCEF() {
  // Use stable CEF version for macOS, current for Windows and Linux
  // full urls for reference:
  // macos x64: https://cef-builds.spotifycdn.com/cef_binary_125.0.22%2Bgc410c95%2Bchromium-125.0.6422.142_macosx64_minimal.tar.bz2
  // macos arm64: https://cef-builds.spotifycdn.com/cef_binary_125.0.22%2Bgc410c95%2Bchromium-125.0.6422.142_macosarm64_minimal.tar.bz2
  // windows x64: https://cef-builds.spotifycdn.com/cef_binary_125.0.22%2Bgc410c95%2Bchromium-125.0.6422.142_windows64_minimal.tar.bz2
  // windows arm64: https://cef-builds.spotifycdn.com/cef_binary_125.0.22%2Bgc410c95%2Bchromium-125.0.6422.142_windowsarm64_minimal.tar.bz2
  // linux x64: https://cef-builds.spotifycdn.com/cef_binary_125.0.22%2Bgc410c95%2Bchromium-125.0.6422.142_linux64_minimal.tar.bz2
  // linux arm64: https://cef-builds.spotifycdn.com/cef_binary_125.0.22%2Bgc410c95%2Bchromium-125.0.6422.142_linuxarm64_minimal.tar.bz2

  const CEF_VERSION_MAC = `125.0.22+gc410c95`;
  const CHROMIUM_VERSION_MAC = `125.0.6422.142`;
  const CEF_VERSION_WIN = `125.0.22+gc410c95`;
  const CHROMIUM_VERSION_WIN = `125.0.6422.142`;
  const CEF_VERSION_LINUX = `125.0.22+gc410c95`;
  const CHROMIUM_VERSION_LINUX = `125.0.6422.142`;

  if (OS === 'macos') {
    if (!existsSync(join(process.cwd(), 'vendors', 'cef'))) {
      const cefArch = ARCH === 'arm64' ? 'macosarm64' : 'macosx64';
      console.log(`Downloading CEF for macOS ${ARCH}...`);
      // Try a different URL format - encode all + symbols
      let cefUrl = `https://cef-builds.spotifycdn.com/cef_binary_${CEF_VERSION_MAC}+chromium-${CHROMIUM_VERSION_MAC}_${cefArch}_minimal.tar.bz2`;
      console.log('CEF URL:', cefUrl);

      // Test if URL is accessible first
      console.log('Testing CEF URL accessibility...');
      try {
        await $`curl -I "${cefUrl}"`;
        console.log('CEF URL is accessible');
      } catch (error) {
        console.log('CEF URL test failed, trying alternative format...');
        // Try simpler format without the complex version encoding
        const altUrl = `https://cef-builds.spotifycdn.com/cef_binary_125.0.22_${cefArch}_minimal.tar.bz2`;
        console.log('Alternative CEF URL:', altUrl);
        try {
          await $`curl -I "${altUrl}"`;
          console.log('Alternative URL works, using it');
          cefUrl = altUrl;
        } catch (altError) {
          throw new Error(
            'Neither CEF URL format worked. Manual intervention needed.'
          );
        }
      }

      // Download to temp file first, then extract
      await $`mkdir -p vendors`;
      const tempFile = 'vendors/cef_temp.tar.bz2';
      await $`curl -L "${cefUrl}" -o "${tempFile}"`;

      // Check if download succeeded
      if (!existsSync(tempFile)) {
        throw new Error('CEF download failed - temp file not created');
      }

      console.log('CEF download completed, extracting...');

      // Extract CEF
      await $`mkdir -p vendors/cef`;
      try {
        await $`tar -xjf "${tempFile}" --strip-components=1 -C vendors/cef`;
        console.log('CEF extraction completed');
      } catch (error) {
        console.log('Tar extraction failed, trying alternative method...');
        // Try without strip-components first
        await $`tar -xjf "${tempFile}" -C vendors/`;

        // List what was extracted
        const vendorContents = await $`ls vendors/`.text();
        console.log('Extracted contents:', vendorContents);

        // Try to find the CEF directory and move it
        const dirName = vendorContents
          .split('\n')
          .find((line) => line.startsWith('cef_binary_'));
        if (dirName) {
          await $`mv vendors/${dirName.trim()}/* vendors/cef/`;
          await $`rmdir vendors/${dirName.trim()}`;
          console.log('Moved CEF contents to vendors/cef');
        }
      }

      // Clean up temp file
      await $`rm "${tempFile}"`;

      // List what's in the cef directory
      try {
        const cefContents = await $`ls vendors/cef/`.text();
        console.log('CEF directory contents:', cefContents);
      } catch (e) {
        console.log('Could not list CEF directory contents');
      }

      // Verify CEF was extracted properly
      if (
        !existsSync(join(process.cwd(), 'vendors', 'cef', 'CMakeLists.txt'))
      ) {
        throw new Error(
          'CEF download/extraction failed - CMakeLists.txt not found'
        );
      }
      console.log('CEF downloaded and extracted successfully');
    }

    // Build process_helper binary
    if (
      !existsSync(
        join(process.cwd(), 'src', 'native', 'build', 'process_helper')
      )
    ) {
      await $`mkdir -p src/native/build`;
      // build CEF wrapper library
      console.log('Building CEF wrapper library...');
      const buildArch = ARCH === 'arm64' ? 'arm64' : 'x86_64';
      await $`cd vendors/cef && rm -rf build && mkdir -p build && cd build && "${CMAKE_BIN}" -DPROJECT_ARCH="${buildArch}" -DCMAKE_BUILD_TYPE=Release .. && make -j8 libcef_dll_wrapper`;

      // Verify the wrapper library was built
      const wrapperPath = join(
        process.cwd(),
        'vendors',
        'cef',
        'build',
        'libcef_dll_wrapper',
        'libcef_dll_wrapper.a'
      );
      if (!existsSync(wrapperPath)) {
        throw new Error(`CEF wrapper library not found at ${wrapperPath}`);
      }
      console.log('CEF wrapper library built successfully');

      // build helper
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
      // Always use x64 for Windows since we only build x64 Windows binaries
      const cefArch = 'windows64';
      console.log('Downloading CEF for Windows x64...');
      await $`curl -L "https://cef-builds.spotifycdn.com/cef_binary_${CEF_VERSION_WIN}%2Bchromium-${CHROMIUM_VERSION_WIN}_${cefArch}_minimal.tar.bz2" -o "${tempPath}"`;

      // Verify download completed
      if (!existsSync(tempPath)) {
        throw new Error('Download failed - file not found');
      }

      const { statSync } = await import('fs');
      const stats = statSync(tempPath);
      console.log(`Downloaded file size: ${stats.size} bytes`);

      if (stats.size < 1000000) {
        // Less than 1MB indicates failed download
        throw new Error(
          `Download failed - file too small: ${stats.size} bytes`
        );
      }

      // Extract using tar (Windows 10+ has built-in tar support)
      console.log('Extracting CEF...');
      await $`powershell -command "New-Item -ItemType Directory -Path 'vendors/cef_temp' -Force | Out-Null"`;
      await $`powershell -command "New-Item -ItemType Directory -Path 'vendors/cef' -Force | Out-Null"`;

      // Extract tar.bz2 using Windows built-in tar
      console.log('Extracting with tar (this may take a few minutes)...');
      console.log(
        'Note: Windows tar extraction of bz2 files can be slow, please be patient...'
      );

      // Windows tar doesn't support many options, just use basic extraction
      const relativeTempPath = relative('vendors/cef_temp', tempPath);
      await $`cd vendors/cef_temp && tar -xjf "${relativeTempPath}"`;

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
      const cefCMakeFile = join(
        process.cwd(),
        'vendors',
        'cef',
        'CMakeLists.txt'
      );
      if (!existsSync(cefCMakeFile)) {
        throw new Error('CEF extraction failed - CMakeLists.txt not found');
      }
      console.log('CEF extracted successfully');
    }

    // Build CEF wrapper library for Windows
    if (
      !existsSync(
        join(
          process.cwd(),
          'vendors',
          'cef',
          'build',
          'libcef_dll_wrapper',
          'Release',
          'libcef_dll_wrapper.lib'
        )
      )
    ) {
      // Clean and create build directory (Windows cmd semantics)
      execSync('if exist build rmdir /s /q build', {
        cwd: join(process.cwd(), 'vendors', 'cef'),
        shell: 'cmd.exe',
        stdio: 'inherit',
      });
      execSync('mkdir build', {
        cwd: join(process.cwd(), 'vendors', 'cef'),
        shell: 'cmd.exe',
        stdio: 'inherit',
      });
      // Generate Visual Studio project with sandbox disabled
      execSync(
        `"${CMAKE_BIN}" -G "Visual Studio 17 2022" -A x64 -DCEF_USE_SANDBOX=OFF -DCMAKE_BUILD_TYPE=Release ..`,
        {
          cwd: join(process.cwd(), 'vendors', 'cef', 'build'),
          shell: 'cmd.exe',
          stdio: 'inherit',
        }
      );
      // Build the wrapper library only
      // await $`cd vendors/cef/build && msbuild cef.sln /p:Configuration=Release /p:Platform=x64 /target:libcef_dll_wrapper`;
      // const msbuildPath = await $`"C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe" -latest -requires Microsoft.Component.MSBuild -find MSBuild\\**\\Bin\\MSBuild.exe | head -n 1`.text();
      // await $`cd vendors/cef/build && "${msbuildPath.trim()}" cef.sln /p:Configuration=Release /p:Platform=x64 /target:libcef_dll_wrapper`;
      execSync(
        `"${CMAKE_BIN}" --build . --config Release --target libcef_dll_wrapper`,
        {
          cwd: join(process.cwd(), 'vendors', 'cef', 'build'),
          shell: 'cmd.exe',
          stdio: 'inherit',
        }
      );
    }

    // Build process_helper binary for Windows
    if (
      !existsSync(
        join(process.cwd(), 'src', 'native', 'build', 'process_helper.exe')
      )
    ) {
      await $`mkdir -p src/native/build`;

      const cefInclude = `./vendors/cef`;
      const cefLib = `./vendors/cef/Release/libcef.lib`;
      const cefWrapperLib = `./vendors/cef/build/libcef_dll_wrapper/Release/libcef_dll_wrapper.lib`;

      // Compile and link the Windows helper process
      const helperCmd = `cl /c /EHsc /std:c++17 /I"${cefInclude}" /D_USRDLL /D_WINDLL /Fo"src/native/build/process_helper_win.obj" "src/native/win/cef_process_helper_win.cpp" && link /OUT:"src/native/build/process_helper.exe" user32.lib ole32.lib shell32.lib "${cefLib}" "${cefWrapperLib}" /SUBSYSTEM:WINDOWS "src/native/build/process_helper_win.obj"`;
      await executeWithVisualStudio(helperCmd, 'CEF helper');
    }
  } else if (OS === 'linux') {
    if (!existsSync(join(process.cwd(), 'vendors', 'cef'))) {
      const cefArch = ARCH === 'arm64' ? 'linuxarm64' : 'linux64';
      await $`mkdir -p vendors/cef && curl -L "https://cef-builds.spotifycdn.com/cef_binary_${CEF_VERSION_LINUX}%2Bchromium-${CHROMIUM_VERSION_LINUX}_${cefArch}_minimal.tar.bz2" | tar -xj --strip-components=1 -C vendors/cef`;
    }

    // Build CEF wrapper library for Linux
    if (
      !existsSync(
        join(
          process.cwd(),
          'vendors',
          'cef',
          'build',
          'libcef_dll_wrapper',
          'libcef_dll_wrapper.a'
        )
      )
    ) {
      console.log('Building CEF wrapper library for Linux...');
      await $`cd vendors/cef && rm -rf build && mkdir -p build`;

      if (ARCH === 'arm64') {
        // For ARM64, we need to modify CEF's cmake files to remove -m64 flags
        console.log('Patching CEF cmake files for ARM64...');

        // Replace -m64 and -march=x86-64 with ARM64 equivalents in cef_variables.cmake
        const cefVariablesPath = join(
          process.cwd(),
          'vendors',
          'cef',
          'cmake',
          'cef_variables.cmake'
        );
        if (existsSync(cefVariablesPath)) {
          let cefVariables = readFileSync(cefVariablesPath, 'utf-8');
          cefVariables = cefVariables.replace(/-m64/g, '');
          cefVariables = cefVariables.replace(
            /-march=x86-64/g,
            '-march=armv8-a'
          );
          writeFileSync(cefVariablesPath, cefVariables);
        }

        await $`cd vendors/cef/build && "${CMAKE_BIN}" -DCEF_USE_SANDBOX=OFF -DCMAKE_BUILD_TYPE=Release -DPROJECT_ARCH=arm64 ..`;
      } else {
        await $`cd vendors/cef/build && "${CMAKE_BIN}" -DCEF_USE_SANDBOX=OFF -DCMAKE_BUILD_TYPE=Release ..`;
      }

      await $`cd vendors/cef/build && make -j$(nproc) libcef_dll_wrapper`;
    }

    // Build process_helper binary for Linux
    if (
      !existsSync(
        join(process.cwd(), 'src', 'native', 'build', 'process_helper')
      )
    ) {
      console.log('Building CEF process helper for Linux...');
      await $`mkdir -p src/native/build`;

      const cefInclude = `./vendors/cef`;
      const cefLib = `./vendors/cef/Release/libcef.so`;
      const cefWrapperLib = `./vendors/cef/build/libcef_dll_wrapper/libcef_dll_wrapper.a`;

      // Compile the Linux helper process
      await $`g++ -c -std=c++17 -I"${cefInclude}" -o src/native/build/process_helper_linux.o src/native/linux/cef_process_helper_linux.cpp`;

      // Link to create the helper executable
      await $`g++ -o src/native/build/process_helper src/native/build/process_helper_linux.o "${cefWrapperLib}" "${cefLib}" -Wl,-rpath,'$ORIGIN' -lpthread -ldl`;
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
    const webview2Dir = readdirSync(webview2BasePath).find((dir: string) =>
      dir.startsWith('Microsoft.Web.WebView2')
    );

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

async function vendorLinuxDeps() {
  if (OS === 'linux') {
    console.log(
      'Skipping Linux dependency installation (assuming already installed)'
    );

    // Dependencies should already be installed:
    // sudo apt update && sudo apt install -y build-essential cmake pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev

    // TODO: Add dependency checking instead of automatic installation
    // const requiredPackages = ['build-essential', 'cmake', 'pkg-config', 'libgtk-3-dev', 'libwebkit2gtk-4.1-dev'];
    // for (const pkg of requiredPackages) {
    //     const result = await $`dpkg -l | grep ${pkg}`.catch(() => null);
    //     if (!result) {
    //         console.log(`Warning: Required package ${pkg} may not be installed`);
    //     }
    // }
  }
}

async function buildTRDiff() {
  const zigArgs =
    OS === 'win' ? ['-Dtarget=x86_64-windows', '-Dcpu=baseline'] : [];
  const zigPath = join(
    process.cwd(),
    'vendors',
    'zig',
    'zig' + (OS === 'win' ? '.exe' : '')
  );
  const bsdiffPath = join(process.cwd(), 'src', 'bsdiff');

  if (CHANNEL === 'debug') {
    await $`cd ${bsdiffPath} && ${zigPath} build ${zigArgs}`;
  } else {
    await $`cd ${bsdiffPath} && ${zigPath} build -Doptimize=ReleaseFast ${zigArgs}`;
  }
}

/**
 * Sets up Visual Studio environment and executes a compile/link command on Windows.
 * Uses vswhere.exe to find Visual Studio installation dynamically.
 */
async function executeWithVisualStudio(
  command: string,
  description: string
): Promise<void> {
  if (OS !== 'win') {
    throw new Error('executeWithVisualStudio should only be called on Windows');
  }

  // Check if Visual Studio environment is already set up
  let needsVsSetup = false;
  try {
    // Ensure we use cmd.exe where.exe semantics on Windows
    execSync('where cl', { shell: 'cmd.exe', stdio: 'ignore' });
    console.log('✓ Visual Studio environment already configured');
  } catch {
    needsVsSetup = true;
    console.log(`Setting up Visual Studio environment for ${description}...`);
  }

  if (needsVsSetup) {
    // Find Visual Studio installation using vswhere.exe
    let vcvarsPath: string;
    const vswherePath =
      'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
    let vsInstallPath = '';
    try {
      vsInstallPath = execSync(
        `"${vswherePath}" -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`,
        { encoding: 'utf8', shell: 'cmd.exe' }
      ).trim();
    } catch (e) {
      // vswhere not found or failed — fall through to generic error
    }

    if (!vsInstallPath) {
      throw new Error(
        'Visual Studio C++ build tools not found. Install Visual Studio (or Build Tools) with C++ tools, or run from a Developer command prompt where cl is available.'
      );
    }

    vcvarsPath = `${vsInstallPath}\\VC\\Auxiliary\\Build\\vcvarsall.bat`;
    console.log(`Found Visual Studio at: ${vsInstallPath}`);

    // Execute command with Visual Studio environment
    const fullCommand = `"${vcvarsPath}" x64 && ${command}`;
    execSync(fullCommand, { shell: 'cmd.exe', stdio: 'inherit' });
  } else {
    // Environment already set up, execute command directly
    execSync(command, { shell: 'cmd.exe', stdio: 'inherit' });
  }
}

async function buildNative() {
  if (OS === 'macos') {
    // Ensure CEF wrapper library is built first
    const wrapperPath = join(
      process.cwd(),
      'vendors',
      'cef',
      'build',
      'libcef_dll_wrapper',
      'libcef_dll_wrapper.a'
    );
    if (!existsSync(wrapperPath)) {
      console.log('CEF wrapper library not found, building it now...');
      const buildArch = ARCH === 'arm64' ? 'arm64' : 'x86_64';
      await $`cd vendors/cef && rm -rf build && mkdir -p build && cd build && "${CMAKE_BIN}" -DPROJECT_ARCH="${buildArch}" -DCMAKE_BUILD_TYPE=Release .. && make -j8 libcef_dll_wrapper`;

      if (!existsSync(wrapperPath)) {
        throw new Error(
          `Failed to build CEF wrapper library at ${wrapperPath}`
        );
      }
    }

    await $`mkdir -p src/native/macos/build && clang++ -c src/native/macos/nativeWrapper.mm -o src/native/macos/build/nativeWrapper.o -fobjc-arc -fno-objc-msgsend-selector-stubs -I./vendors/cef -std=c++17`;
    await $`mkdir -p src/native/build && clang++ -o src/native/build/libNativeWrapper.dylib src/native/macos/build/nativeWrapper.o -framework Cocoa -framework WebKit -framework QuartzCore -F./vendors/cef/Release -weak_framework 'Chromium Embedded Framework' -L./vendors/cef/build/libcef_dll_wrapper -lcef_dll_wrapper -stdlib=libc++ -shared -install_name @executable_path/libNativeWrapper.dylib`;
  } else if (OS === 'win') {
    const webview2Include = `./vendors/webview2/Microsoft.Web.WebView2/build/native/include`;
    // Always use x64 for Windows since we only build x64 Windows binaries
    const webview2Arch = 'x64';
    const webview2Lib = `./vendors/webview2/Microsoft.Web.WebView2/build/native/${webview2Arch}/WebView2LoaderStatic.lib`;
    const cefInclude = `./vendors/cef`;
    const cefLib = `./vendors/cef/Release/libcef.lib`;
    const cefWrapperLib = `./vendors/cef/build/libcef_dll_wrapper/Release/libcef_dll_wrapper.lib`;

    // Compile the main wrapper with both WebView2 and CEF support (runtime detection)
    await $`mkdir -p src/native/win/build`;

    const compileAndLinkCmd = `cl /c /EHsc /std:c++17 /I"${webview2Include}" /I"${cefInclude}" /D_USRDLL /D_WINDLL /Fo"src/native/win/build/nativeWrapper.obj" "src/native/win/nativeWrapper.cpp" && link /DLL /OUT:"src/native/win/build/libNativeWrapper.dll" user32.lib ole32.lib shell32.lib shlwapi.lib advapi32.lib dcomp.lib d2d1.lib "${webview2Lib}" "${cefLib}" "${cefWrapperLib}" delayimp.lib /DELAYLOAD:libcef.dll /IMPLIB:"src/native/win/build/libNativeWrapper.lib" "src/native/win/build/nativeWrapper.obj"`;
    await executeWithVisualStudio(
      compileAndLinkCmd,
      'native wrapper compilation'
    );
  } else if (OS === 'linux') {
    try {
      // Check if required packages are available first
      await $`pkg-config --exists webkit2gtk-4.1 gtk+-3.0 ayatana-appindicator3-0.1`;

      // Always include CEF headers for Linux builds
      const cefInclude = join(process.cwd(), 'vendors', 'cef');
      const cefLib = join(
        process.cwd(),
        'vendors',
        'cef',
        'Release',
        'libcef.so'
      );
      const cefWrapperLib = join(
        process.cwd(),
        'vendors',
        'cef',
        'build',
        'libcef_dll_wrapper',
        'libcef_dll_wrapper.a'
      );

      // Check if CEF libraries exist for linking
      const cefLibsExist = existsSync(cefWrapperLib) && existsSync(cefLib);

      if (cefLibsExist) {
        console.log('CEF libraries found, building with full CEF support');
      } else {
        console.log(
          'CEF libraries not found, building with CEF headers only (runtime detection)'
        );
      }

      // Compile the main wrapper with WebKitGTK, AppIndicator, and CEF headers
      await $`mkdir -p src/native/linux/build`;
      await $`g++ -c -std=c++17 -fPIC $(pkg-config --cflags webkit2gtk-4.1 gtk+-3.0 ayatana-appindicator3-0.1) -I"${cefInclude}" -o src/native/linux/build/nativeWrapper.o src/native/linux/nativeWrapper.cpp`;

      // Link with WebKitGTK, AppIndicator, and optionally CEF libraries using weak linking
      await $`mkdir -p src/native/build`;

      // Build both GTK-only and CEF versions for Linux to allow small bundles
      console.log('Building GTK-only version (libNativeWrapper.so)');
      await $`g++ -shared -o src/native/build/libNativeWrapper.so src/native/linux/build/nativeWrapper.o $(pkg-config --libs webkit2gtk-4.1 gtk+-3.0 ayatana-appindicator3-0.1) -ldl -lpthread`;

      if (cefLibsExist) {
        console.log('Building CEF version (libNativeWrapper_cef.so)');
        await $`g++ -shared -o src/native/build/libNativeWrapper_cef.so src/native/linux/build/nativeWrapper.o $(pkg-config --libs webkit2gtk-4.1 gtk+-3.0 ayatana-appindicator3-0.1) -Wl,--whole-archive ${cefWrapperLib} -Wl,--no-whole-archive -Wl,--as-needed ${cefLib} -ldl -lpthread -Wl,-rpath,'$ORIGIN:$ORIGIN/cef'`;
        console.log(
          'Built both GTK-only and CEF versions for flexible deployment'
        );
      } else {
        console.log('CEF libraries not found - only GTK version built');
      }

      console.log('Native wrapper built successfully');
    } catch (error: any) {
      console.log('Build failed, error details:', error.message);
      throw error;
    }
  }
}

async function buildLauncher() {
  let zigArgs: string[] = [];

  // Set target architecture based on platform
  if (OS === 'win') {
    zigArgs = ['-Dtarget=x86_64-windows', '-Dcpu=baseline'];
  } else if (OS === 'macos') {
    // Build universal binary or native architecture
    if (ARCH === 'arm64') {
      zigArgs = ['-Dtarget=aarch64-macos'];
    } else {
      zigArgs = ['-Dtarget=x86_64-macos'];
    }
  }
  // Linux builds native by default

  const zigPath = join(
    process.cwd(),
    'vendors',
    'zig',
    'zig' + (OS === 'win' ? '.exe' : '')
  );
  const launcherPath = join(process.cwd(), 'src', 'launcher');

  if (CHANNEL === 'debug') {
    await $`cd ${launcherPath} && ${zigPath} build ${zigArgs}`;
  } else if (CHANNEL === 'release') {
    await $`cd ${launcherPath} && ${zigPath} build -Doptimize=ReleaseSmall ${zigArgs}`;
  }
}

async function buildMainJs() {
  const bunModule = await import('bun');
  const result = await bunModule.build({
    entrypoints: [join('src', 'launcher', 'main.ts')],
    outdir: join('dist'),
    external: [],
    // minify: true, // todo (yoav): add minify in canary and prod builds
    target: 'bun',
  });

  // Verify main.js was created
  const mainJsPath = join('dist', 'main.js');
  if (!existsSync(mainJsPath)) {
    throw new Error(
      `main.js was not created at ${mainJsPath}. Build result: ${JSON.stringify(
        result
      )}`
    );
  }
  console.log(`main.js built successfully at ${mainJsPath}`);

  return result;
}

async function buildSelfExtractor() {
  const zigArgs =
    OS === 'win' ? ['-Dtarget=x86_64-windows', '-Dcpu=baseline'] : [];
  const zigPath = join(
    process.cwd(),
    'vendors',
    'zig',
    'zig' + (OS === 'win' ? '.exe' : '')
  );
  const extractorPath = join(process.cwd(), 'src', 'extractor');

  if (CHANNEL === 'debug') {
    await $`cd ${extractorPath} && ${zigPath} build ${zigArgs}`;
  } else if (CHANNEL === 'release') {
    await $`cd ${extractorPath} && ${zigPath} build -Doptimize=ReleaseSmall ${zigArgs}`;
  }
}

async function buildCli() {
  // await $`bun build src/cli/index.ts --compile --outfile src/cli/build/electrobun`;

  const compileTarget =
    process.platform === 'win32' ? '--target=bun-windows-x64-baseline' : '';

  await $`BUN_INSTALL_CACHE_DIR=/tmp/bun-cache bun build src/cli/index.ts --compile ${compileTarget} --outfile src/cli/build/electrobun`;
}

async function generateTemplateEmbeddings() {
  const TEMPLATES_DIR = join(process.cwd(), 'templates');
  const OUTPUT_FILE = join(process.cwd(), 'src/cli/templates/embedded.ts');

  if (!existsSync(TEMPLATES_DIR)) {
    console.log('No templates directory found, skipping template generation');
    return;
  }

  const templates: Record<
    string,
    { name: string; files: Record<string, string> }
  > = {};

  // Read all template directories
  const templateNames = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);

  if (templateNames.length === 0) {
    console.log('No templates found in templates/ directory');
    return;
  }

  for (const templateName of templateNames) {
    const templateDir = join(TEMPLATES_DIR, templateName);
    const files: Record<string, string> = {};

    // Recursively read all files in the template directory
    function readDirectory(dir: string, basePath: string = '') {
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        const relativePath = join(basePath, entry.name).replace(/\\/g, '/');

        // Skip common directories and files that shouldn't be in templates
        if (
          entry.name === 'node_modules' ||
          entry.name === '.git' ||
          entry.name === 'build' ||
          entry.name === 'dist' ||
          entry.name === '.next' ||
          entry.name === '.DS_Store' ||
          entry.name.startsWith('.') ||
          entry.name === 'package-lock.json' ||
          entry.name === 'bun.lockb' ||
          entry.name === 'yarn.lock'
        ) {
          continue;
        }

        if (entry.isDirectory()) {
          readDirectory(fullPath, relativePath);
        } else {
          try {
            const content = readFileSync(fullPath, 'utf-8');
            files[relativePath] = content;
          } catch (error) {
            console.warn(`Warning: Could not read ${fullPath}:`, error);
          }
        }
      }
    }

    readDirectory(templateDir);

    templates[templateName] = {
      name: templateName,
      files,
    };
  }

  // Generate TypeScript file using JSON.stringify for proper escaping
  const output = `// Auto-generated file. Do not edit directly.
// Generated from templates/ directory

export interface Template {
  name: string;
  files: Record<string, string>;
}

export const templates: Record<string, Template> = ${JSON.stringify(
    templates,
    null,
    2
  )};

export function getTemplateNames(): string[] {
  return Object.keys(templates);
}

export function getTemplate(name: string): Template | undefined {
  return templates[name];
}
`;

  // Ensure the output directory exists
  const outputDir = dirname(OUTPUT_FILE);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Write the output file
  writeFileSync(OUTPUT_FILE, output);

  const totalFiles = Object.values(templates).reduce(
    (acc, t) => acc + Object.keys(t.files).length,
    0
  );
  console.log(
    `Generated ${totalFiles} template files for ${
      templateNames.length
    } templates: ${templateNames.join(', ')}`
  );
}
