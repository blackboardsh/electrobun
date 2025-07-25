import { join, dirname, basename } from "path";
import {
  existsSync,
  readFileSync,
  cpSync,
  rmdirSync,
  mkdirSync,
  createWriteStream,
  unlinkSync,
} from "fs";
import { execSync } from "child_process";
import tar from "tar";
import { ZstdInit } from "@oneidentity/zstd-js/wasm";
import {platform, arch} from 'os';
// import { loadBsdiff, loadBspatch } from 'bsdiff-wasm';
// MacOS named pipes hang at around 4KB
const MAX_CHUNK_SIZE = 1024 * 2;

// TODO: dedup with built.ts
const OS: 'win' | 'linux' | 'macos' = getPlatform();
const ARCH: 'arm64' | 'x64' = getArch();

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


const binExt = OS === 'win' ? '.exe' : '';

// this when run as an npm script this will be where the folder where package.json is.
const projectRoot = process.cwd();
const configName = "electrobun.config";
const configPath = join(projectRoot, configName);

// Note: cli args can be called via npm bun /path/to/electorbun/binary arg1 arg2
const indexOfElectrobun = process.argv.findIndex((arg) =>
  arg.includes("electrobun")
);
const commandArg = process.argv[indexOfElectrobun + 1] || "launcher";

const ELECTROBUN_DEP_PATH = join(projectRoot, "node_modules", "electrobun");

// When debugging electrobun with the example app use the builds (dev or release) right from the source folder
// For developers using electrobun cli via npm use the release versions in /dist
// This lets us not have to commit src build folders to git and provide pre-built binaries
const PATHS = {
  BUN_BINARY: join(ELECTROBUN_DEP_PATH, "dist", "bun") + binExt,
  LAUNCHER_DEV: join(ELECTROBUN_DEP_PATH, "dist", "electrobun") + binExt,
  LAUNCHER_RELEASE: join(ELECTROBUN_DEP_PATH, "dist", "launcher") + binExt,
  MAIN_JS: join(ELECTROBUN_DEP_PATH, "dist", "main.js"),  
  NATIVE_WRAPPER_MACOS: join(
    ELECTROBUN_DEP_PATH,
    "dist",
    "libNativeWrapper.dylib"
  ),
  NATIVE_WRAPPER_WIN: join(ELECTROBUN_DEP_PATH, "dist", "libNativeWrapper.dll"),
  NATIVE_WRAPPER_LINUX: join(ELECTROBUN_DEP_PATH, "dist", "libNativeWrapper.so"),
  WEBVIEW2LOADER_WIN: join(ELECTROBUN_DEP_PATH, "dist", "WebView2Loader.dll"),
  BSPATCH: join(ELECTROBUN_DEP_PATH, "dist", "bspatch") + binExt,
  EXTRACTOR: join(ELECTROBUN_DEP_PATH, "dist", "extractor") + binExt,
  BSDIFF: join(ELECTROBUN_DEP_PATH, "dist", "bsdiff") + binExt,
  CEF_FRAMEWORK_MACOS: join(
    ELECTROBUN_DEP_PATH,
    "dist",
    "cef",
    "Chromium Embedded Framework.framework"
  ),
  CEF_HELPER_MACOS: join(ELECTROBUN_DEP_PATH, "dist", "cef", "process_helper"),
  CEF_HELPER_WIN: join(ELECTROBUN_DEP_PATH, "dist", "cef", "process_helper.exe"),
  CEF_HELPER_LINUX: join(ELECTROBUN_DEP_PATH, "dist", "cef", "process_helper"),
  CEF_DIR: join(ELECTROBUN_DEP_PATH, "dist", "cef"),
};

async function ensureCoreDependencies() {
  // Check if all core dependencies exist
  const requiredFiles = [
    PATHS.BUN_BINARY,
    PATHS.LAUNCHER_RELEASE,
    PATHS.MAIN_JS,
    // Platform-specific native wrapper
    OS === 'macos' ? PATHS.NATIVE_WRAPPER_MACOS :
    OS === 'win' ? PATHS.NATIVE_WRAPPER_WIN :
    PATHS.NATIVE_WRAPPER_LINUX
  ];
  
  const allFilesExist = requiredFiles.every(file => existsSync(file));
  if (allFilesExist) {
    return;
  }

  // Show which files are missing
  const missingFiles = requiredFiles.filter(file => !existsSync(file));
  console.log('Core dependencies not found. Missing files:', missingFiles.map(f => f.replace(ELECTROBUN_DEP_PATH, '.')).join(', '));
  console.log('Downloading core binaries...');
  
  // Get the current Electrobun version from package.json
  const packageJsonPath = join(ELECTROBUN_DEP_PATH, 'package.json');
  let version = 'latest';
  
  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      version = `v${packageJson.version}`;
    } catch (error) {
      console.warn('Could not read package version, using latest');
    }
  }

  const platformName = OS === 'macos' ? 'darwin' : OS === 'win' ? 'win32' : 'linux';
  const archName = ARCH;
  const coreTarballUrl = `https://github.com/blackboardsh/electrobun/releases/download/${version}/electrobun-core-${platformName}-${archName}.tar.gz`;
  
  console.log(`Downloading core binaries from: ${coreTarballUrl}`);
  
  try {
    // Download core binaries tarball
    const response = await fetch(coreTarballUrl);
    if (!response.ok) {
      throw new Error(`Failed to download binaries: ${response.status} ${response.statusText}`);
    }
    
    // Create temp file
    const tempFile = join(ELECTROBUN_DEP_PATH, 'main-temp.tar.gz');
    const fileStream = createWriteStream(tempFile);
    
    // Write response to file
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fileStream.write(Buffer.from(value));
      }
    }
    fileStream.end();
    
    // Extract to dist directory
    console.log('Extracting core dependencies...');
    const distPath = join(ELECTROBUN_DEP_PATH, 'dist');
    mkdirSync(distPath, { recursive: true });
    
    await tar.x({
      file: tempFile,
      cwd: distPath,
    });
    
    // Clean up temp file
    unlinkSync(tempFile);
    
    console.log('Core dependencies downloaded and cached successfully');
    
  } catch (error) {
    console.error('Failed to download core dependencies:', error.message);
    console.error('Please ensure you have an internet connection and the release exists.');
    process.exit(1);
  }
}

async function ensureCEFDependencies() {
  // Check if CEF dependencies already exist
  if (existsSync(PATHS.CEF_DIR)) {
    console.log('CEF dependencies found, using cached version');
    return;
  }

  console.log('CEF dependencies not found, downloading...');
  
  // Get the current Electrobun version from package.json
  const packageJsonPath = join(ELECTROBUN_DEP_PATH, 'package.json');
  let version = 'latest';
  
  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      version = `v${packageJson.version}`;
    } catch (error) {
      console.warn('Could not read package version, using latest');
    }
  }

  const platformName = OS === 'macos' ? 'darwin' : OS === 'win' ? 'win32' : 'linux';
  const archName = ARCH;
  const cefTarballUrl = `https://github.com/blackboardsh/electrobun/releases/download/${version}/electrobun-cef-${platformName}-${archName}.tar.gz`;
  
  console.log(`Downloading CEF from: ${cefTarballUrl}`);
  
  try {
    // Download CEF tarball
    const response = await fetch(cefTarballUrl);
    if (!response.ok) {
      throw new Error(`Failed to download CEF: ${response.status} ${response.statusText}`);
    }
    
    // Create temp file
    const tempFile = join(ELECTROBUN_DEP_PATH, 'cef-temp.tar.gz');
    const fileStream = createWriteStream(tempFile);
    
    // Write response to file
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fileStream.write(Buffer.from(value));
      }
    }
    fileStream.end();
    
    // Extract to dist directory
    console.log('Extracting CEF dependencies...');
    await tar.x({
      file: tempFile,
      cwd: join(ELECTROBUN_DEP_PATH, 'dist'),
    });
    
    // Clean up temp file
    unlinkSync(tempFile);
    
    console.log('CEF dependencies downloaded and cached successfully');
    
  } catch (error) {
    console.error('Failed to download CEF dependencies:', error.message);
    console.error('Please ensure you have an internet connection and the release exists.');
    process.exit(1);
  }
}

const commandDefaults = {
  init: {
    projectRoot,
    config: "electrobun.config",
  },
  build: {
    projectRoot,
    config: "electrobun.config",
  },
  dev: {
    projectRoot,
    config: "electrobun.config",
  },
  launcher: {
    projectRoot,
    config: "electrobun.config",
  },
};

// todo (yoav): add types for config
const defaultConfig = {
  app: {
    name: "MyApp",
    identifier: "com.example.myapp",
    version: "0.1.0",
  },
  build: {
    buildFolder: "build",
    artifactFolder: "artifacts",
    mac: {
      codesign: false,
      notarize: false,
      bundleCEF: false,
      entitlements: {
        // This entitlement is required for Electrobun apps with a hardened runtime (required for notarization) to run on macos
        "com.apple.security.cs.allow-jit": true,
      },
      icons: "icon.iconset",
    },
    bun: {
      entrypoint: "src/bun/index.ts",
      external: [],
    },
  },
  scripts: {
    postBuild: "",
  },
  release: {
    bucketUrl: "",
  },
};

const command = commandDefaults[commandArg];

if (!command) {
  console.error("Invalid command: ", commandArg);
  process.exit(1);
}

const config = getConfig();

const envArg =
  process.argv.find((arg) => arg.startsWith("env="))?.split("=")[1] || "";

const validEnvironments = ["dev", "canary", "stable"];

// todo (yoav): dev, canary, and stable;
const buildEnvironment: "dev" | "canary" | "stable" =
  validEnvironments.includes(envArg) ? envArg : "dev";

// todo (yoav): dev builds should include the branch name, and/or allow configuration via external config
const buildSubFolder = `${buildEnvironment}`;

const buildFolder = join(projectRoot, config.build.buildFolder, buildSubFolder);

const artifactFolder = join(
  projectRoot,
  config.build.artifactFolder,
  buildSubFolder
);

const buildIcons = (appBundleFolderResourcesPath: string) => {
  if (OS === 'macos' && config.build.mac.icons) {
    const iconSourceFolder = join(projectRoot, config.build.mac.icons);
    const iconDestPath = join(appBundleFolderResourcesPath, "AppIcon.icns");
    if (existsSync(iconSourceFolder)) {
      Bun.spawnSync(
        ["iconutil", "-c", "icns", "-o", iconDestPath, iconSourceFolder],
        {
          cwd: appBundleFolderResourcesPath,
          stdio: ["ignore", "inherit", "inherit"],
          env: {
            ...process.env,
            ELECTROBUN_BUILD_ENV: buildEnvironment,
          },
        }
      );
    }
  }
};

function escapePathForTerminal(filePath: string) {
  // List of special characters to escape
  const specialChars = [
    " ",
    "(",
    ")",
    "&",
    "|",
    ";",
    "<",
    ">",
    "`",
    "\\",
    '"',
    "'",
    "$",
    "*",
    "?",
    "[",
    "]",
    "#",
  ];

  let escapedPath = "";
  for (const char of filePath) {
    if (specialChars.includes(char)) {
      escapedPath += `\\${char}`;
    } else {
      escapedPath += char;
    }
  }

  return escapedPath;
}
// MyApp

// const appName = config.app.name.replace(/\s/g, '-').toLowerCase();

const appFileName = (
  buildEnvironment === "stable"
    ? config.app.name
    : `${config.app.name}-${buildEnvironment}`
)
  .replace(/\s/g, "")
  .replace(/\./g, "-");
const bundleFileName = OS === 'macos' ? `${appFileName}.app` : appFileName;

// const logPath = `/Library/Logs/Electrobun/ExampleApp/dev/out.log`;

let proc = null;

if (commandArg === "init") {
  // todo (yoav): init a repo folder structure
  console.log("initializing electrobun project");
} else if (commandArg === "build") {
  // Ensure core binaries are available before starting build
  await ensureCoreDependencies();
  
  // refresh build folder  
  if (existsSync(buildFolder)) {
    rmdirSync(buildFolder, { recursive: true });
  }  
  mkdirSync(buildFolder, { recursive: true });  
  // bundle bun to build/bun
  const bunConfig = config.build.bun;
  const bunSource = join(projectRoot, bunConfig.entrypoint);

  if (!existsSync(bunSource)) {
    console.error(
      `failed to bundle ${bunSource} because it doesn't exist.\n You need a config.build.bun.entrypoint source file to build.`
    );
    process.exit(1);
  }

  // build macos bundle
  const {
    appBundleFolderPath,
    appBundleFolderContentsPath,
    appBundleMacOSPath,
    appBundleFolderResourcesPath,
    appBundleFolderFrameworksPath,
  } = createAppBundle(appFileName, buildFolder);

  const appBundleAppCodePath = join(appBundleFolderResourcesPath, "app");

  mkdirSync(appBundleAppCodePath, { recursive: true });

  // const bundledBunPath = join(appBundleMacOSPath, 'bun');
  // cpSync(bunPath, bundledBunPath);

  // Note: for sandboxed apps, MacOS will use the CFBundleIdentifier to create a unique container for the app,
  // mirroring folders like Application Support, Caches, etc. in the user's Library folder that the sandboxed app
  // gets access to.

  // We likely want to let users configure this for different environments (eg: dev, canary, stable) and/or
  // provide methods to help segment data in those folders based on channel/environment
  const InfoPlistContents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>launcher</string>
    <key>CFBundleIdentifier</key>
    <string>${config.app.identifier}</string>
    <key>CFBundleName</key>
    <string>${appFileName}</string>
    <key>CFBundleVersion</key>
    <string>${config.app.version}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
</dict>
</plist>`;

  await Bun.write(
    join(appBundleFolderContentsPath, "Info.plist"),
    InfoPlistContents
  );  
  // in dev builds the log file is a named pipe so we can stream it back to the terminal
  // in canary/stable builds it'll be a regular log file
  //     const LauncherContents = `#!/bin/bash
  // # change directory from whatever open was or double clicking on the app to the dir of the bin in the app bundle
  // cd "$(dirname "$0")"/

  // # Define the log file path
  // LOG_FILE="$HOME/${logPath}"

  // # Ensure the directory exists
  // mkdir -p "$(dirname "$LOG_FILE")"

  // if [[ ! -p $LOG_FILE ]]; then
  //     mkfifo $LOG_FILE
  // fi

  // # Execute bun and redirect stdout and stderr to the log file
  // ./bun ../Resources/app/bun/index.js >"$LOG_FILE" 2>&1
  // `;

  //     // Launcher binary
  //     // todo (yoav): This will likely be a zig compiled binary in the future
  //     Bun.write(join(appBundleMacOSPath, 'MyApp'), LauncherContents);
  //     chmodSync(join(appBundleMacOSPath, 'MyApp'), '755');
  // const zigLauncherBinarySource = join(projectRoot, 'node_modules', 'electrobun', 'src', 'launcher', 'zig-out', 'bin', 'launcher');
  // const zigLauncherDestination = join(appBundleMacOSPath, 'MyApp');
  // const destLauncherFolder = dirname(zigLauncherDestination);
  // if (!existsSync(destLauncherFolder)) {
  //     // console.info('creating folder: ', destFolder);
  //     mkdirSync(destLauncherFolder, {recursive: true});
  // }
  // cpSync(zigLauncherBinarySource, zigLauncherDestination, {recursive: true, dereference: true});
  // For dev builds, use the actual CLI binary that's currently running
  // It could be in .cache (npm install) or bin (local dev)
  let devLauncherPath = PATHS.LAUNCHER_DEV;
  if (buildEnvironment === "dev" && !existsSync(devLauncherPath)) {
    // Check .cache location (npm installed)
    const cachePath = join(ELECTROBUN_DEP_PATH, ".cache", "electrobun") + binExt;
    if (existsSync(cachePath)) {
      devLauncherPath = cachePath;
    } else {
      // Check bin location (local dev)
      const binPath = join(ELECTROBUN_DEP_PATH, "bin", "electrobun") + binExt;
      if (existsSync(binPath)) {
        devLauncherPath = binPath;
      }
    }
  }
  
  const bunCliLauncherBinarySource =
    buildEnvironment === "dev"
      ? devLauncherPath
      : // Note: for release use the zig launcher optimized for smol size
        PATHS.LAUNCHER_RELEASE;
  const bunCliLauncherDestination = join(appBundleMacOSPath, "launcher") + binExt;
  const destLauncherFolder = dirname(bunCliLauncherDestination);
  if (!existsSync(destLauncherFolder)) {
    // console.info('creating folder: ', destFolder);
    mkdirSync(destLauncherFolder, { recursive: true });
  }

  cpSync(bunCliLauncherBinarySource, bunCliLauncherDestination, {
    recursive: true,
    dereference: true,
  });

  cpSync(PATHS.MAIN_JS, join(appBundleMacOSPath, 'main.js'));

  // Bun runtime binary
  // todo (yoav): this only works for the current architecture
  const bunBinarySourcePath = PATHS.BUN_BINARY;
  // Note: .bin/bun binary in node_modules is a symlink to the versioned one in another place
  // in node_modules, so we have to dereference here to get the actual binary in the bundle.
  const bunBinaryDestInBundlePath = join(appBundleMacOSPath, "bun") + binExt;
  const destFolder2 = dirname(bunBinaryDestInBundlePath);
  if (!existsSync(destFolder2)) {
    // console.info('creating folder: ', destFolder);
    mkdirSync(destFolder2, { recursive: true });
  }
  cpSync(bunBinarySourcePath, bunBinaryDestInBundlePath, { dereference: true });

  // copy native wrapper dynamic library
  if (OS === 'macos') {
  const nativeWrapperMacosSource = PATHS.NATIVE_WRAPPER_MACOS;
  const nativeWrapperMacosDestination = join(
    appBundleMacOSPath,
    "libNativeWrapper.dylib"
  );  
  cpSync(nativeWrapperMacosSource, nativeWrapperMacosDestination, {
    dereference: true,
  });
} else if (OS === 'win') {
  const nativeWrapperMacosSource = PATHS.NATIVE_WRAPPER_WIN;
  const nativeWrapperMacosDestination = join(
    appBundleMacOSPath,
    "libNativeWrapper.dll"
  );  
  cpSync(nativeWrapperMacosSource, nativeWrapperMacosDestination, {
    dereference: true,
  });

  const webview2LibSource = PATHS.WEBVIEW2LOADER_WIN;
  const webview2LibDestination = join(
    appBundleMacOSPath,
    "WebView2Loader.dll"
  );  ;
  // copy webview2 system webview library
  cpSync(webview2LibSource, webview2LibDestination);
  
} else if (OS === 'linux') {
  const nativeWrapperLinuxSource = PATHS.NATIVE_WRAPPER_LINUX;
  const nativeWrapperLinuxDestination = join(
    appBundleMacOSPath,
    "libNativeWrapper.so"
  );
  if (existsSync(nativeWrapperLinuxSource)) {
    cpSync(nativeWrapperLinuxSource, nativeWrapperLinuxDestination, {
      dereference: true,
    });
  }
}
  

  // Download CEF binaries if needed when bundleCEF is enabled
  if ((OS === 'macos' && config.build.mac?.bundleCEF) || 
      (OS === 'win' && config.build.win?.bundleCEF) || 
      (OS === 'linux' && config.build.linux?.bundleCEF)) {
    
    await ensureCEFDependencies();    
    if (OS === 'macos') {
      const cefFrameworkSource = PATHS.CEF_FRAMEWORK_MACOS;
      const cefFrameworkDestination = join(
        appBundleFolderFrameworksPath,
        "Chromium Embedded Framework.framework"
      );

      cpSync(cefFrameworkSource, cefFrameworkDestination, {
        recursive: true,
        dereference: true,
      });
    

      // cef helpers
      const cefHelperNames = [
        "bun Helper",
        "bun Helper (Alerts)",
        "bun Helper (GPU)",
        "bun Helper (Plugin)",
        "bun Helper (Renderer)",
      ];

      const helperSourcePath = PATHS.CEF_HELPER_MACOS;
      cefHelperNames.forEach((helperName) => {
        const destinationPath = join(
          appBundleFolderFrameworksPath,
          `${helperName}.app`,
          `Contents`,
          `MacOS`,
          `${helperName}`
        );
        
        const destFolder4 = dirname(destinationPath);
        if (!existsSync(destFolder4)) {
          // console.info('creating folder: ', destFolder4);
          mkdirSync(destFolder4, { recursive: true });
        }
        cpSync(helperSourcePath, destinationPath, {
          recursive: true,
          dereference: true,
        });
      });
    } else if (OS === 'win') {
      // Copy CEF DLLs from dist/cef/ to the main executable directory
      const electrobunDistPath = join(ELECTROBUN_DEP_PATH, "dist");
      const cefSourcePath = join(electrobunDistPath, "cef");
      const cefDllFiles = [
        'libcef.dll',
        'chrome_elf.dll', 
        'd3dcompiler_47.dll',
        'libEGL.dll',
        'libGLESv2.dll',
        'vk_swiftshader.dll',
        'vulkan-1.dll'
      ];
      
      cefDllFiles.forEach(dllFile => {
        const sourcePath = join(cefSourcePath, dllFile);
        const destPath = join(appBundleMacOSPath, dllFile);
        if (existsSync(sourcePath)) {
          cpSync(sourcePath, destPath);
        }
      });
      
      // Copy icudtl.dat to MacOS root (same folder as libcef.dll) - required for CEF initialization
      const icuDataSource = join(cefSourcePath, 'icudtl.dat');
      const icuDataDest = join(appBundleMacOSPath, 'icudtl.dat');
      if (existsSync(icuDataSource)) {
        cpSync(icuDataSource, icuDataDest);
      }
      
      // Copy essential CEF pak files to MacOS root (same folder as libcef.dll) - required for CEF resources
      const essentialPakFiles = ['chrome_100_percent.pak', 'resources.pak', 'v8_context_snapshot.bin'];
      essentialPakFiles.forEach(pakFile => {
        const sourcePath = join(cefSourcePath, pakFile);
        const destPath = join(appBundleMacOSPath, pakFile);

        if (existsSync(sourcePath)) {
          cpSync(sourcePath, destPath);
        } else {
          console.log(`WARNING: Missing CEF file: ${sourcePath}`);
        }
      });
      
      // Copy CEF resources to MacOS/cef/ subdirectory for other resources like locales
      const cefResourcesSource = join(electrobunDistPath, 'cef');
      const cefResourcesDestination = join(appBundleMacOSPath, 'cef');
      
      if (existsSync(cefResourcesSource)) {
        cpSync(cefResourcesSource, cefResourcesDestination, {
          recursive: true,
          dereference: true,
        });
      }

      // Copy CEF helper processes with different names
      const cefHelperNames = [
        "bun Helper",
        "bun Helper (Alerts)", 
        "bun Helper (GPU)",
        "bun Helper (Plugin)",
        "bun Helper (Renderer)",
      ];

      const helperSourcePath = PATHS.CEF_HELPER_WIN;
      if (existsSync(helperSourcePath)) {
        cefHelperNames.forEach((helperName) => {
          const destinationPath = join(appBundleMacOSPath, `${helperName}.exe`);
          cpSync(helperSourcePath, destinationPath);
          
        });
      } else {
        console.log(`WARNING: Missing CEF helper: ${helperSourcePath}`);
      }
    } else if (OS === 'linux') {
      // Copy CEF shared libraries from dist/cef/ to the main executable directory
      const electrobunDistPath = join(ELECTROBUN_DEP_PATH, "dist");
      const cefSourcePath = join(electrobunDistPath, "cef");
      
      if (existsSync(cefSourcePath)) {
        const cefSoFiles = [
          'libcef.so',
          'libEGL.so',
          'libGLESv2.so',
          'libvk_swiftshader.so',
          'libvulkan.so.1'
        ];
        
        cefSoFiles.forEach(soFile => {
          const sourcePath = join(cefSourcePath, soFile);
          const destPath = join(appBundleMacOSPath, soFile);
          if (existsSync(sourcePath)) {
            cpSync(sourcePath, destPath);
          }
        });
        
        // Copy icudtl.dat to MacOS root (same folder as libcef.so) - required for CEF initialization
        const icuDataSource = join(cefSourcePath, 'icudtl.dat');
        const icuDataDest = join(appBundleMacOSPath, 'icudtl.dat');
        if (existsSync(icuDataSource)) {
          cpSync(icuDataSource, icuDataDest);
        }
        
        // Copy .pak files and other CEF resources to the main executable directory
        const pakFiles = [
          'icudtl.dat', 
          'v8_context_snapshot.bin', 
          'snapshot_blob.bin',
          'resources.pak', 
          'chrome_100_percent.pak',
          'chrome_200_percent.pak',
          'locales',
          'chrome-sandbox',
          'vk_swiftshader_icd.json'
        ];
        pakFiles.forEach(pakFile => {
          const sourcePath = join(cefSourcePath, pakFile);
          const destPath = join(appBundleMacOSPath, pakFile);
          if (existsSync(sourcePath)) {
            cpSync(sourcePath, destPath, { recursive: true });
          }
        });
        
        // Copy locales to cef subdirectory
        const cefResourcesDestination = join(appBundleMacOSPath, 'cef');
        if (!existsSync(cefResourcesDestination)) {
          mkdirSync(cefResourcesDestination, { recursive: true });
        }
        
        // Copy all CEF shared libraries to cef subdirectory as well (for RPATH $ORIGIN/cef)
        cefSoFiles.forEach(soFile => {
          const sourcePath = join(cefSourcePath, soFile);
          const destPath = join(cefResourcesDestination, soFile);
          if (existsSync(sourcePath)) {
            cpSync(sourcePath, destPath);
            console.log(`Copied CEF library to cef subdirectory: ${soFile}`);
          } else {
            console.log(`WARNING: Missing CEF library: ${sourcePath}`);
          }
        });
        
        // Copy essential CEF files to cef subdirectory as well (for RPATH $ORIGIN/cef)
        const cefEssentialFiles = ['vk_swiftshader_icd.json'];
        cefEssentialFiles.forEach(cefFile => {
          const sourcePath = join(cefSourcePath, cefFile);
          const destPath = join(cefResourcesDestination, cefFile);
          if (existsSync(sourcePath)) {
            cpSync(sourcePath, destPath);
            console.log(`Copied CEF essential file to cef subdirectory: ${cefFile}`);
          } else {
            console.log(`WARNING: Missing CEF essential file: ${sourcePath}`);
          }
        });
        
        // Copy CEF helper processes with different names
        const cefHelperNames = [
          "bun Helper",
          "bun Helper (Alerts)", 
          "bun Helper (GPU)",
          "bun Helper (Plugin)",
          "bun Helper (Renderer)",
        ];

        const helperSourcePath = PATHS.CEF_HELPER_LINUX;
        if (existsSync(helperSourcePath)) {
          cefHelperNames.forEach((helperName) => {
            const destinationPath = join(appBundleMacOSPath, helperName);
            cpSync(helperSourcePath, destinationPath);
            console.log(`Copied CEF helper: ${helperName}`);
          });
        } else {
          console.log(`WARNING: Missing CEF helper: ${helperSourcePath}`);
        }
      }
    }
  }


  // copy native bindings
  const bsPatchSource = PATHS.BSPATCH;
  const bsPatchDestination = join(appBundleMacOSPath, "bspatch") + binExt;
  const bsPatchDestFolder = dirname(bsPatchDestination);
  if (!existsSync(bsPatchDestFolder)) {
    mkdirSync(bsPatchDestFolder, { recursive: true });
  }

  cpSync(bsPatchSource, bsPatchDestination, {
    recursive: true,
    dereference: true,
  });

  // transpile developer's bun code
  const bunDestFolder = join(appBundleAppCodePath, "bun");
  // Build bun-javascript ts files
  const buildResult = await Bun.build({
    entrypoints: [bunSource],
    outdir: bunDestFolder,
    external: bunConfig.external || [],
    // minify: true, // todo (yoav): add minify in canary and prod builds
    target: "bun",
  });

  if (!buildResult.success) {
    console.error("failed to build", bunSource, buildResult.logs);
    process.exit(1);
  }

  // transpile developer's view code
  // Build webview-javascript ts files
  // bundle all the bundles
  for (const viewName in config.build.views) {
    const viewConfig = config.build.views[viewName];

    const viewSource = join(projectRoot, viewConfig.entrypoint);
    if (!existsSync(viewSource)) {
      console.error(`failed to bundle ${viewSource} because it doesn't exist.`);
      continue;
    }

    const viewDestFolder = join(appBundleAppCodePath, "views", viewName);

    if (!existsSync(viewDestFolder)) {
      // console.info('creating folder: ', viewDestFolder);
      mkdirSync(viewDestFolder, { recursive: true });
    } else {
      console.error(
        "continuing, but ",
        viewDestFolder,
        "unexpectedly already exists in the build folder"
      );
    }

    // console.info(`bundling ${viewSource} to ${viewDestFolder} with config: `, viewConfig);

    const buildResult = await Bun.build({
      entrypoints: [viewSource],
      outdir: viewDestFolder,
      external: viewConfig.external || [],
      target: "browser",
    });

    if (!buildResult.success) {
      console.error("failed to build", viewSource, buildResult.logs);
      continue;
    }
  }
  // Copy assets like html, css, images, and other files
  for (const relSource in config.build.copy) {
    const source = join(projectRoot, relSource);
    if (!existsSync(source)) {
      console.error(`failed to copy ${source} because it doesn't exist.`);
      continue;
    }

    const destination = join(
      appBundleAppCodePath,
      config.build.copy[relSource]
    );
    const destFolder = dirname(destination);

    if (!existsSync(destFolder)) {
      // console.info('creating folder: ', destFolder);
      mkdirSync(destFolder, { recursive: true });
    }

    // todo (yoav): add ability to swap out BUILD VARS
    cpSync(source, destination, { recursive: true, dereference: true });
  }


  buildIcons(appBundleFolderResourcesPath);
  
  
  // Run postBuild script
  if (config.scripts.postBuild) {

    Bun.spawnSync([bunBinarySourcePath, config.scripts.postBuild], {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        ELECTROBUN_BUILD_ENV: buildEnvironment,
      },
    });
  }
  // All the unique files are in the bundle now. Create an initial temporary tar file
  // for hashing the contents
  // tar the signed and notarized app bundle
  const tmpTarPath = `${appBundleFolderPath}-temp.tar`;
  await tar.c(
    {
      gzip: false,
      file: tmpTarPath,
      cwd: buildFolder,
    },
    [basename(appBundleFolderPath)]
  );
  const tmpTarball = Bun.file(tmpTarPath);
  const tmpTarBuffer = await tmpTarball.arrayBuffer();
  // Note: wyhash is the default in Bun.hash but that may change in the future
  // so we're being explicit here.
  const hash = Bun.hash.wyhash(tmpTarBuffer, 43770n).toString(36);

  unlinkSync(tmpTarPath);
  // const bunVersion = execSync(`${bunBinarySourcePath} --version`).toString().trim();

  // version.json inside the app bundle
  const versionJsonContent = JSON.stringify({
    version: config.app.version,
    // The first tar file does not include this, it gets hashed,
    // then the hash is included in another tar file. That later one
    // then gets used for patching and updating.
    hash: hash,
    channel: buildEnvironment,
    bucketUrl: config.release.bucketUrl,
    name: appFileName,
    identifier: config.app.identifier,
  });

  await Bun.write(
    join(appBundleFolderResourcesPath, "version.json"),
    versionJsonContent
  );

  // todo (yoav): add these to config
  const shouldCodesign =
    buildEnvironment !== "dev" && config.build.mac.codesign;
  const shouldNotarize = shouldCodesign && config.build.mac.notarize;

  if (shouldCodesign) {
    codesignAppBundle(
      appBundleFolderPath,
      join(buildFolder, "entitlements.plist")
    );
  } else {
    console.log("skipping codesign");
  }

  // codesign
  // NOTE: Codesigning fails in dev mode (when using a single-file-executable bun cli as the launcher)
  // see https://github.com/oven-sh/bun/issues/7208
  if (shouldNotarize) {
    notarizeAndStaple(appBundleFolderPath);
  } else {
    console.log("skipping notarization");
  }
  if (buildEnvironment !== "dev")  {
    const artifactsToUpload = [];
    // zstd wasm https://github.com/OneIdentity/zstd-js
    // tar https://github.com/isaacs/node-tar

    // steps:
    // 1. [done] build the app bundle, code sign, notarize, staple.
    // 2. tar and zstd the app bundle (two separate files)
    // 3. build another app bundle for the self-extracting app bundle with the zstd in Resources
    // 4. code sign and notarize the self-extracting app bundle
    // 5. while waiting for that notarization, download the prev app bundle, extract the tar, and generate a bsdiff patch
    // 6. when notarization is complete, generate a dmg of the self-extracting app bundle
    // 6.5. code sign and notarize the dmg
    // 7. copy artifacts to directory [self-extractor dmg, zstd app bundle, bsdiff patch, update.json]

    const tarPath = `${appBundleFolderPath}.tar`;

    // tar the signed and notarized app bundle
    await tar.c(
      {
        gzip: false,
        file: tarPath,
        cwd: buildFolder,
      },
      [basename(appBundleFolderPath)]
    );

    const tarball = Bun.file(tarPath);
    const tarBuffer = await tarball.arrayBuffer();

    // Note: The playground app bundle is around 48MB.
    // compression on m1 max with 64GB ram:
    //   brotli: 1min 38s, 48MB -> 11.1MB
    //   zstd: 15s, 48MB -> 12.1MB
    // zstd is the clear winner here. dev iteration speed gain of 1min 15s per build is much more valubale
    // than saving 1 more MB of space/bandwidth.

    const compressedTarPath = `${tarPath}.zst`;
    artifactsToUpload.push(compressedTarPath);

    // zstd compress tarball
    // todo (yoav): consider using c bindings for zstd for speed instead of wasm
    // we already have it in the bsdiff binary
    console.log("compressing tarball...");
    await ZstdInit().then(async ({ ZstdSimple, ZstdStream }) => {
      // Note: Simple is much faster than stream, but stream is better for large files
      // todo (yoav): consider a file size cutoff to switch to stream instead of simple.
      if (tarball.size > 0) {
        // Uint8 array filestream of the tar file

        const data = new Uint8Array(tarBuffer);
        const compressionLevel = 22;
        const compressedData = ZstdSimple.compress(data, compressionLevel);

        console.log(
          "compressed",
          compressedData.length,
          "bytes",
          "from",
          data.length,
          "bytes"
        );

        await Bun.write(compressedTarPath, compressedData);
      }
    });

    // we can delete the original app bundle since we've tarred and zstd it. We need to create the self-extracting app bundle
    // now and it needs the same name as the original app bundle.
    rmdirSync(appBundleFolderPath, { recursive: true });

    const selfExtractingBundle = createAppBundle(appFileName, buildFolder);
    const compressedTarballInExtractingBundlePath = join(
      selfExtractingBundle.appBundleFolderResourcesPath,
      `${hash}.tar.zst`
    );

    // copy the zstd tarball to the self-extracting app bundle
    cpSync(compressedTarPath, compressedTarballInExtractingBundlePath);

    const selfExtractorBinSourcePath = PATHS.EXTRACTOR;
    const selfExtractorBinDestinationPath = join(
      selfExtractingBundle.appBundleMacOSPath,
      "launcher"
    );

    cpSync(selfExtractorBinSourcePath, selfExtractorBinDestinationPath, {
      dereference: true,
    });

    buildIcons(appBundleFolderResourcesPath);
    await Bun.write(
      join(selfExtractingBundle.appBundleFolderContentsPath, "Info.plist"),
      InfoPlistContents
    );

    if (shouldCodesign) {
      codesignAppBundle(
        selfExtractingBundle.appBundleFolderPath,
        join(buildFolder, "entitlements.plist")
      );
    } else {
      console.log("skipping codesign");
    }

    // Note: we need to notarize the original app bundle, the self-extracting app bundle, and the dmg
    if (shouldNotarize) {
      notarizeAndStaple(selfExtractingBundle.appBundleFolderPath);
    } else {
      console.log("skipping notarization");
    }

    console.log("creating dmg...");
    // make a dmg
    const dmgPath = join(buildFolder, `${appFileName}.dmg`);
    artifactsToUpload.push(dmgPath);
    // hdiutil create -volname "YourAppName" -srcfolder /path/to/YourApp.app -ov -format UDZO YourAppName.dmg
    // Note: use UDBZ for better compression vs. UDZO
    execSync(
      `hdiutil create -volname "${appFileName}" -srcfolder ${escapePathForTerminal(
        appBundleFolderPath
      )} -ov -format UDBZ ${escapePathForTerminal(dmgPath)}`
    );

    if (shouldCodesign) {
      codesignAppBundle(dmgPath);
    } else {
      console.log("skipping codesign");
    }

    if (shouldNotarize) {
      notarizeAndStaple(dmgPath);
    } else {
      console.log("skipping notarization");
    }

    // refresh artifacts folder
    console.log("creating artifacts folder...");
    if (existsSync(artifactFolder)) {
      console.info("deleting artifact folder: ", artifactFolder);
      rmdirSync(artifactFolder, { recursive: true });
    }

    mkdirSync(artifactFolder, { recursive: true });

    console.log("creating update.json...");
    // update.json for the channel in that channel's build folder
    const updateJsonContent = JSON.stringify({
      // The version isn't really used for updating, but it's nice to have for
      // the download button or display on your marketing site or in the app.
      version: config.app.version,
      hash: hash.toString(),
      // channel: buildEnvironment,
      // bucketUrl: config.release.bucketUrl
    });

    await Bun.write(join(artifactFolder, "update.json"), updateJsonContent);

    // generate bsdiff
    // https://storage.googleapis.com/eggbun-static/electrobun-playground/canary/ElectrobunPlayground-canary.app.tar.zst
    console.log("bucketUrl: ", config.release.bucketUrl);

    console.log("generating a patch from the previous version...");
    const urlToPrevUpdateJson = join(
      config.release.bucketUrl,
      buildEnvironment,
      `update.json`
    );
    const cacheBuster = Math.random().toString(36).substring(7);
    const updateJsonResponse = await fetch(
      urlToPrevUpdateJson + `?${cacheBuster}`
    ).catch((err) => {
      console.log("bucketURL not found: ", err);
    });

    const urlToLatestTarball = join(
      config.release.bucketUrl,
      buildEnvironment,
      `${appFileName}.app.tar.zst`
    );


    // attempt to get the previous version to create a patch file
    if (updateJsonResponse.ok) {
      const prevUpdateJson = await updateJsonResponse.json();

      const prevHash = prevUpdateJson.hash;
      console.log("PREVIOUS HASH", prevHash);

      // todo (yoav): should be able to stream and decompress in the same step

      const response = await fetch(urlToLatestTarball + `?${cacheBuster}`);
      const prevVersionCompressedTarballPath = join(
        buildFolder,
        "prev.tar.zst"
      );

      if (response.ok && response.body) {
        const reader = response.body.getReader();

        const writer = Bun.file(prevVersionCompressedTarballPath).writer();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
        }
        await writer.flush();
        writer.end();

        console.log("decompress prev funn bundle...");
        const prevTarballPath = join(buildFolder, "prev.tar");
        await ZstdInit().then(async ({ ZstdSimple }) => {
          const data = new Uint8Array(
            await Bun.file(prevVersionCompressedTarballPath).arrayBuffer()
          );
          const uncompressedData = ZstdSimple.decompress(data);
          await Bun.write(prevTarballPath, uncompressedData);
        });

        console.log("diff previous and new tarballs...");
        // Run it as a separate process to leverage multi-threadedness
        // especially for creating multiple diffs in parallel
        const bsdiffpath = PATHS.BSDIFF;
        const patchFilePath = join(buildFolder, `${prevHash}.patch`);
        artifactsToUpload.push(patchFilePath);
        const result = Bun.spawnSync(
          [bsdiffpath, prevTarballPath, tarPath, patchFilePath, "--use-zstd"],
          { cwd: buildFolder }
        );
        console.log(
          "bsdiff result: ",
          result.stdout.toString(),
          result.stderr.toString()
        );
      }
    } else {
      console.log("prevoius version not found at: ", urlToLatestTarball);
      console.log("skipping diff generation");
    }

    // compress all the upload files
    console.log("copying artifacts...");

    artifactsToUpload.forEach((filePath) => {
      const filename = basename(filePath);
      cpSync(filePath, join(artifactFolder, filename));
    });

    // todo: now just upload the artifacts to your bucket replacing the ones that exist
    // you'll end up with a sequence of patch files that will
  }

  // NOTE: verify codesign
  //  codesign --verify --deep --strict --verbose=2 <app path>

  // Note: verify notarization
  // spctl --assess --type execute --verbose <app path>

  // Note: for .dmg spctl --assess will respond with "rejected (*the code is valid* but does not seem to be an app)" which is valid
  // an actual failed response for a dmg is "source=no usable signature"
  // for a dmg.
  // can also use stapler validate -v to validate the dmg and look for teamId, signingId, and the response signedTicket
  // stapler validate -v <app path>
} else if (commandArg === "dev") {
  // todo (yoav): rename to start

  // run the project in dev mode
  // this runs the cli in debug mode, on macos executes the app bundle,
  // there is another copy of the cli in the app bundle that will execute the app
  // the two cli processes communicate via named pipes and together manage the dev
  // lifecycle and debug functionality

  // Note: this cli will be a bun single-file-executable
  // Note: we want to use the version of bun that's packaged with electrobun
  // const bunPath = join(projectRoot, 'node_modules', '.bin', 'bun');
  // const mainPath = join(buildFolder, 'bun', 'index.js');
  // const mainPath = join(buildFolder, bundleFileName);
  // console.log('running ', bunPath, mainPath);

  // Note: open will open the app bundle as a completely different process
  // This is critical to fully test the app (including plist configuration, etc.)
  // but also to get proper cmd+tab and dock behaviour and not run the windowed app
  // as a child of the terminal process which steels keyboard focus from any descendant nswindows.
  // Bun.spawn(["open", mainPath], {
  //   env: {},
  // });

  let mainProc;
  let bundleExecPath: string;
  
  if (OS === 'macos') {
    bundleExecPath = join(buildFolder, bundleFileName, "Contents", 'MacOS');
  } else if (OS === 'linux' || OS === 'win') {
    bundleExecPath = join(buildFolder, bundleFileName, "bin");
  } else {
    throw new Error(`Unsupported OS: ${OS}`);
  }

  if (OS === 'macos') {

    mainProc = Bun.spawn([join(bundleExecPath,'bun'), join(bundleExecPath, 'main.js')], {
      stdio: ['inherit', 'inherit', 'inherit'],
      cwd: bundleExecPath
    })
  } else if (OS === 'win') {  
    // Try the main process
    mainProc =  Bun.spawn(['./bun.exe', './main.js'], {
      stdio: ['inherit', 'inherit', 'inherit'],
      cwd: bundleExecPath,
      onExit: (proc, exitCode, signalCode, error) => {
        console.log('Bun process exited:', { exitCode, signalCode, error });
      }
    })
  } else if (OS === 'linux') {
    let env = { ...process.env };
    
    // Add LD_PRELOAD for CEF libraries to fix static TLS allocation issues
    if (config.build.linux?.bundleCEF) {
      const cefLibs = ['./libcef.so', './libvk_swiftshader.so'];
      const existingCefLibs = cefLibs.filter(lib => existsSync(join(bundleExecPath, lib)));
      
      if (existingCefLibs.length > 0) {
        env['LD_PRELOAD'] = existingCefLibs.join(':');
        console.log(`Using LD_PRELOAD for CEF: ${env['LD_PRELOAD']}`);
      }
    }
    
    mainProc = Bun.spawn([join(bundleExecPath, 'bun'), join(bundleExecPath, 'main.js')], {
      stdio: ['inherit', 'inherit', 'inherit'],
      cwd: bundleExecPath,
      env
    })
  }

  process.on("SIGINT", () => {
    console.log('exit command')
    // toLauncherPipe.write("exit command\n");      
    mainProc.kill();
    process.exit();
  });

} 

function getConfig() {
  let loadedConfig = {};
  if (existsSync(configPath)) {
    const configFileContents = readFileSync(configPath, "utf8");
    // Note: we want this to hard fail if there's a syntax error
    try {
      loadedConfig = JSON.parse(configFileContents);
    } catch (error) {
      console.error("Failed to parse config file:", error);
      console.error("using default config instead");
    }
  }

  // todo (yoav): write a deep clone fn
  return {
    ...defaultConfig,
    ...loadedConfig,
    app: {
      ...defaultConfig.app,
      ...(loadedConfig?.app || {}),
    },
    build: {
      ...defaultConfig.build,
      ...(loadedConfig?.build || {}),
      mac: {
        ...defaultConfig.build.mac,
        ...(loadedConfig?.build?.mac || {}),
        entitlements: {
          ...defaultConfig.build.mac.entitlements,
          ...(loadedConfig?.build?.mac?.entitlements || {}),
        },
      },
      win: {
        ...defaultConfig.build.win,
        ...(loadedConfig?.build?.win || {}),
      },
      linux: {
        ...defaultConfig.build.linux,
        ...(loadedConfig?.build?.linux || {}),
      },
      bun: {
        ...defaultConfig.build.bun,
        ...(loadedConfig?.build?.bun || {}),
      }
    },
    scripts: {
      ...defaultConfig.scripts,
      ...(loadedConfig?.scripts || {}),
    },
    release: {
      ...defaultConfig.release,
      ...(loadedConfig?.release || {}),
    },
  };
}

function buildEntitlementsFile(entitlements) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    ${Object.keys(entitlements)
      .map((key) => {
        return `<key>${key}</key>\n${getEntitlementValue(entitlements[key])}`;
      })
      .join("\n")}
</dict>
</plist>
`;
}

function getEntitlementValue(value: boolean | string) {
  if (typeof value === "boolean") {
    return `<${value.toString()}/>`;
  } else {
    return value;
  }
}

function codesignAppBundle(
  appBundleOrDmgPath: string,
  entitlementsFilePath?: string
) {
  console.log("code signing...");
  if (OS !== 'macos' || !config.build.mac.codesign) {
    return;
  }

  const ELECTROBUN_DEVELOPER_ID = process.env["ELECTROBUN_DEVELOPER_ID"];

  if (!ELECTROBUN_DEVELOPER_ID) {
    console.error("Env var ELECTROBUN_DEVELOPER_ID is required to codesign");
    process.exit(1);
  }

  // list of entitlements https://developer.apple.com/documentation/security/hardened_runtime?language=objc
  // todo (yoav): consider allowing separate entitlements config for each binary
  // const entitlementsFilePath = join(buildFolder, 'entitlements.plist');

  // codesign --deep --force --verbose --timestamp --sign "ELECTROBUN_DEVELOPER_ID" --options runtime --entitlements entitlementsFilePath appBundleOrDmgPath`

  if (entitlementsFilePath) {
    const entitlementsFileContents = buildEntitlementsFile(
      config.build.mac.entitlements
    );
    Bun.write(entitlementsFilePath, entitlementsFileContents);

    execSync(
      `codesign --deep --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" --options runtime --entitlements ${entitlementsFilePath} ${escapePathForTerminal(
        appBundleOrDmgPath
      )}`
    );
  } else {
    execSync(
      `codesign --deep --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" ${escapePathForTerminal(
        appBundleOrDmgPath
      )}`
    );
  }
}

function notarizeAndStaple(appOrDmgPath: string) {
  if (OS !== 'macos' || !config.build.mac.notarize) {
    return;
  }

  let fileToNotarize = appOrDmgPath;
  // codesign
  // NOTE: Codesigning fails in dev mode (when using a single-file-executable bun cli as the launcher)
  // see https://github.com/oven-sh/bun/issues/7208
  // if (shouldNotarize) {
  console.log("notarizing...");
  const zipPath = appOrDmgPath + ".zip";
  // if (appOrDmgPath.endsWith('.app')) {
  const appBundleFileName = basename(appOrDmgPath);
  // if we're codesigning the .app we have to zip it first
  execSync(
    `zip -y -r -9 ${escapePathForTerminal(zipPath)} ${escapePathForTerminal(
      appBundleFileName
    )}`,
    {
      cwd: dirname(appOrDmgPath),
    }
  );
  fileToNotarize = zipPath;
  // }

  const ELECTROBUN_APPLEID = process.env["ELECTROBUN_APPLEID"];

  if (!ELECTROBUN_APPLEID) {
    console.error("Env var ELECTROBUN_APPLEID is required to notarize");
    process.exit(1);
  }

  const ELECTROBUN_APPLEIDPASS = process.env["ELECTROBUN_APPLEIDPASS"];

  if (!ELECTROBUN_APPLEIDPASS) {
    console.error("Env var ELECTROBUN_APPLEIDPASS is required to notarize");
    process.exit(1);
  }

  const ELECTROBUN_TEAMID = process.env["ELECTROBUN_TEAMID"];

  if (!ELECTROBUN_TEAMID) {
    console.error("Env var ELECTROBUN_TEAMID is required to notarize");
    process.exit(1);
  }

  // notarize
  // todo (yoav): follow up on options here like --s3-acceleration and --webhook
  // todo (yoav): don't use execSync since it's blocking and we'll only see the output at the end
  const statusInfo = execSync(
    `xcrun notarytool submit --apple-id "${ELECTROBUN_APPLEID}" --password "${ELECTROBUN_APPLEIDPASS}" --team-id "${ELECTROBUN_TEAMID}" --wait ${escapePathForTerminal(
      fileToNotarize
    )}`
  ).toString();
  const uuid = statusInfo.match(/id: ([^\n]+)/)?.[1];
  console.log("statusInfo", statusInfo);
  console.log("uuid", uuid);

  if (statusInfo.match("Current status: Invalid")) {
    console.error("notarization failed", statusInfo);
    const log = execSync(
      `xcrun notarytool log --apple-id "${ELECTROBUN_APPLEID}" --password "${ELECTROBUN_APPLEIDPASS}" --team-id "${ELECTROBUN_TEAMID}" ${uuid}`
    ).toString();
    console.log("log", log);
    process.exit(1);
  }
  // check notarization
  // todo (yoav): actually check result
  // use `notarytool info` or some other request thing to check separately from the wait above

  // stable notarization
  console.log("stapling...");
  execSync(`xcrun stapler staple ${escapePathForTerminal(appOrDmgPath)}`);

  if (existsSync(zipPath)) {
    unlinkSync(zipPath);
  }
}

// Note: supposedly the app bundle name is relevant to code sign/notarization so we need to make the app bundle and the self-extracting wrapper app bundle
// have the same name but different subfolders in our build directory. or I guess delete the first one after tar/compression and then create the other one.
// either way you can pass in the parent folder here for that flexibility.
// for intel/arm builds on mac we'll probably have separate subfolders as well and build them in parallel.
function createAppBundle(bundleName: string, parentFolder: string) {
  if (OS === 'macos') {
    // macOS bundle structure
    const bundleFileName = `${bundleName}.app`;
    const appBundleFolderPath = join(parentFolder, bundleFileName);
    const appBundleFolderContentsPath = join(appBundleFolderPath, "Contents");
    const appBundleMacOSPath = join(appBundleFolderContentsPath, "MacOS");
    const appBundleFolderResourcesPath = join(
      appBundleFolderContentsPath,
      "Resources"
    );
    const appBundleFolderFrameworksPath = join(
      appBundleFolderContentsPath,
      "Frameworks"
    );

    // we don't have to make all the folders, just the deepest ones
    mkdirSync(appBundleMacOSPath, { recursive: true });
    mkdirSync(appBundleFolderResourcesPath, { recursive: true });
    mkdirSync(appBundleFolderFrameworksPath, { recursive: true });

    return {
      appBundleFolderPath,
      appBundleFolderContentsPath,
      appBundleMacOSPath,
      appBundleFolderResourcesPath,
      appBundleFolderFrameworksPath,
    };
  } else if (OS === 'linux' || OS === 'win') {
    // Linux/Windows simpler structure
    const appBundleFolderPath = join(parentFolder, bundleName);
    const appBundleFolderContentsPath = appBundleFolderPath; // No Contents folder needed
    const appBundleMacOSPath = join(appBundleFolderPath, "bin"); // Use bin instead of MacOS
    const appBundleFolderResourcesPath = join(appBundleFolderPath, "Resources");
    const appBundleFolderFrameworksPath = join(appBundleFolderPath, "lib"); // Use lib instead of Frameworks

    // Create directories
    mkdirSync(appBundleMacOSPath, { recursive: true });
    mkdirSync(appBundleFolderResourcesPath, { recursive: true });
    mkdirSync(appBundleFolderFrameworksPath, { recursive: true });

    return {
      appBundleFolderPath,
      appBundleFolderContentsPath,
      appBundleMacOSPath,
      appBundleFolderResourcesPath,
      appBundleFolderFrameworksPath,
    };
  } else {
    throw new Error(`Unsupported OS: ${OS}`);
  }
}
