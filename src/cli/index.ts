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
// import { loadBsdiff, loadBspatch } from 'bsdiff-wasm';

// MacOS named pipes hang at around 4KB
const MAX_CHUNK_SIZE = 1024 * 2;

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
// const SRC_PATH = join(ELECTROBUN_DEP_PATH, "src");
// const ZIGOUT_BIN = join("zig-out", "bin");

// When debugging electrobun with the example app use the builds (dev or release) right from the source folder
// For developers using electrobun cli via npm use the release versions in /dist
// This lets us not have to commit src build folders to git and provide pre-built binaries
const PATHS = {
  BUN_BINARY: join(ELECTROBUN_DEP_PATH, "dist", "bun"),
  LAUNCHER_DEV: join(ELECTROBUN_DEP_PATH, "dist", "electrobun"),
  LAUNCHER_RELEASE: join(ELECTROBUN_DEP_PATH, "dist", "launcher"),
  ZIG_NATIVE_WRAPPER: join(ELECTROBUN_DEP_PATH, "dist", "webview"),
  NATIVE_WRAPPER_MACOS: join(
    ELECTROBUN_DEP_PATH,
    "dist",
    "libNativeWrapper.dylib"
  ),
  BSPATCH: join(ELECTROBUN_DEP_PATH, "dist", "bspatch"),
  EXTRACTOR: join(ELECTROBUN_DEP_PATH, "dist", "extractor"),
  BSDIFF: join(ELECTROBUN_DEP_PATH, "dist", "bsdiff"),
  CEF_FRAMEWORK_MACOS: join(
    ELECTROBUN_DEP_PATH,
    "dist",
    "Chromium Embedded Framework.framework"
  ),
  CEF_HELPER_MACOS: join(ELECTROBUN_DEP_PATH, "dist", "process_helper"),
};

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
  if (config.build.mac.icons) {
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
const bundleFileName = `${appFileName}.app`;

// const logPath = `/Library/Logs/Electrobun/ExampleApp/dev/out.log`;

let proc = null;

if (commandArg === "init") {
  // todo (yoav): init a repo folder structure
  console.log("initializing electrobun project");
} else if (commandArg === "build") {
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

  const bunCliLauncherBinarySource =
    buildEnvironment === "dev"
      ? // Note: in dev use the cli as the launcher
        PATHS.LAUNCHER_DEV
      : // Note: for release use the zig launcher optimized for smol size
        PATHS.LAUNCHER_RELEASE;
  const bunCliLauncherDestination = join(appBundleMacOSPath, "launcher");
  const destLauncherFolder = dirname(bunCliLauncherDestination);
  if (!existsSync(destLauncherFolder)) {
    // console.info('creating folder: ', destFolder);
    mkdirSync(destLauncherFolder, { recursive: true });
  }

  cpSync(bunCliLauncherBinarySource, bunCliLauncherDestination, {
    recursive: true,
    dereference: true,
  });

  // Bun runtime binary
  // todo (yoav): this only works for the current architecture
  const bunBinarySourcePath = PATHS.BUN_BINARY;
  // Note: .bin/bun binary in node_modules is a symlink to the versioned one in another place
  // in node_modules, so we have to dereference here to get the actual binary in the bundle.
  const bunBinaryDestInBundlePath = join(appBundleMacOSPath, "bun");
  const destFolder2 = dirname(bunBinaryDestInBundlePath);
  if (!existsSync(destFolder2)) {
    // console.info('creating folder: ', destFolder);
    mkdirSync(destFolder2, { recursive: true });
  }

  cpSync(bunBinarySourcePath, bunBinaryDestInBundlePath, { dereference: true });

  // Zig native wrapper binary
  // todo (yoav): build native bindings for target
  // copy native bindings
  const zigNativeBinarySource = PATHS.ZIG_NATIVE_WRAPPER;
  const zigNativeBinaryDestination = join(appBundleMacOSPath, "webview");
  const destFolder = dirname(zigNativeBinaryDestination);
  if (!existsSync(destFolder)) {
    // console.info('creating folder: ', destFolder);
    mkdirSync(destFolder, { recursive: true });
  }

  cpSync(zigNativeBinarySource, zigNativeBinaryDestination, {
    recursive: true,
    dereference: true,
  });

  // copy native wrapper dynamic library next to zig native binary
  const nativeWrapperMacosSource = PATHS.NATIVE_WRAPPER_MACOS;
  const nativeWrapperMacosDestination = join(
    appBundleMacOSPath,
    "libNativeWrapper.dylib"
  );  
  cpSync(nativeWrapperMacosSource, nativeWrapperMacosDestination, {
    dereference: true,
  });
  
  // TODO: Should download binaries for arch, and then copy them in
  // for developing Electrobun itself we can assume current arch is already
  // in dist as it would have just been built from local source
  if (config.build.mac.bundleCEF) {    
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
      "webview Helper",
      "webview Helper (Alerts)",
      "webview Helper (GPU)",
      "webview Helper (Plugin)",
      "webview Helper (Renderer)",
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
      const destFolder4 = basename(destinationPath);
      if (!existsSync(destFolder4)) {
        // console.info('creating folder: ', destFolder4);
        mkdirSync(destFolder4, { recursive: true });
      }
      cpSync(helperSourcePath, destinationPath, {
        recursive: true,
        dereference: true,
      });
    });
  }

  // copy native bindings
  const bsPatchSource = PATHS.BSPATCH;
  const bsPatchDestination = join(appBundleMacOSPath, "bspatch");
  const bsPatchDestFolder = dirname(bsPatchDestination);
  if (!existsSync(bsPatchDestFolder)) {
    mkdirSync(bsPatchDestFolder, { recursive: true });
  }

  cpSync(bsPatchSource, bsPatchDestination, {
    recursive: true,
    dereference: true,
  });

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

  if (buildEnvironment === "dev") {
    // in dev mode add a cupla named pipes for some dev debug rpc magic
    const debugPipesFolder = join(appBundleFolderResourcesPath, "debug");
    if (!existsSync(debugPipesFolder)) {
      // console.info('creating folder: ', debugPipesFolder);
      mkdirSync(debugPipesFolder, { recursive: true });
    }
    const toLauncherPipePath = escapePathForTerminal(
      join(debugPipesFolder, "toLauncher")
    );
    const toCliPipePath = escapePathForTerminal(
      join(debugPipesFolder, "toCli")
    );
    try {
      execSync("mkfifo " + toLauncherPipePath);
    } catch (e) {
      console.log("pipe out already exists", e);
    }

    try {
      execSync("mkfifo " + toCliPipePath);
    } catch (e) {
      console.log("pipe out already exists", e);
    }
  } else {
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
  const mainPath = join(buildFolder, bundleFileName);
  // console.log('running ', bunPath, mainPath);

  // Note: open will open the app bundle as a completely different process
  // This is critical to fully test the app (including plist configuration, etc.)
  // but also to get proper cmd+tab and dock behaviour and not run the windowed app
  // as a child of the terminal process which steels keyboard focus from any descendant nswindows.
  Bun.spawn(["open", mainPath], {
    env: {},
  });

  if (buildEnvironment === "dev") {
    const debugPipesFolder = join(
      buildFolder,
      bundleFileName,
      "Contents",
      "Resources",
      "debug"
    );
    const toLauncherPipePath = join(debugPipesFolder, "toLauncher");
    const toCliPipePath = join(debugPipesFolder, "toCli");

    const toCliPipeFile = Bun.file(toCliPipePath);
    const toLauncherPipe = createWriteStream(toLauncherPipePath, {
      flags: "r+",
    });
    toLauncherPipe.write("\n");

    process.on("SIGINT", () => {
      toLauncherPipe.write("exit command\n");
      process.exit();
    });

    const stream = toCliPipeFile.stream();

    async function readFromPipe(
      reader: ReadableStreamDefaultReader<Uint8Array>
    ) {
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += new TextDecoder().decode(value);
        let eolIndex;

        while ((eolIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, eolIndex).trim();
          buffer = buffer.slice(eolIndex + 1);
          if (line) {
            try {
              if (line === "app exiting command") {
                process.exit();
              } else if (line === "subprocess exited command") {
                // Handle subprocess exit
              }

              console.log("bun: ", line);
            } catch (error) {
              console.log("bun: ", line);
            }
          }
        }
      }
    }

    // Call the async function to ensure it runs non-blocking
    const reader = stream.getReader();
    readFromPipe(reader);
  } else {
    console.log("opening", buildEnvironment, "app bundle");
  }
} else {
  // no commands so run as the debug launcher inside the app bundle

  // todo (yoav): as the debug launcher, get the relative path a different way, so dev builds can be shared and executed
  // from different locations
  const pathToLauncherBin = process.argv0;
  const pathToMacOS = dirname(pathToLauncherBin);
  const debugPipesFolder = join(pathToMacOS, "..", "Resources", "debug");
  const toLauncherPipePath = join(debugPipesFolder, "toLauncher");
  const toCliPipePath = join(debugPipesFolder, "toCli");

  // If we open the dev app bundle directly without the cli, then no one will be listening to the toCliPipe
  // and it'll hang. So we open the pipe for reading to prevent it from blocking but we don't read it here.
  const toCliPipe = createWriteStream(toCliPipePath, {
    // Note: open the pipe for reading and writing (r+) so that it doesn't block. If you only open it for writing (w)
    // then it'll block until the cli starts reading. Double clicking on the bundle bypasses the cli so it'll block forever.
    flags: "r+",
  });
  toCliPipe.write("\n");

  const bunRuntimePath = join(pathToMacOS, "bun");
  const appEntrypointPath = join(
    pathToMacOS,
    "..",
    "Resources",
    "app",
    "bun",
    "index.js"
  );

  try {
    proc = Bun.spawn([bunRuntimePath, appEntrypointPath], {
      cwd: pathToMacOS,
      stderr: "pipe",
      onExit: (code) => {
        // todo: In cases where the bun process crashed, there's a lingering process that needs killing
        toCliPipe.write(`subprocess exited command\n`);
        process.kill(process.pid, "SIGINT");
      },
    });
  } catch (e) {
    toCliPipe.write(`error\n ${e}\n`);
  }

  process.on("SIGINT", () => {
    toCliPipe.write("app exiting command\n");
    process.kill(proc.pid, "SIGINT");
    process.exit();
  });

  async function streamPipeToCli(stream) {
    for await (const chunk of stream) {
      let buffer = chunk;
      while (buffer.length > 0) {
        const chunkSize = Math.min(buffer.length, MAX_CHUNK_SIZE);
        const chunkToSend = buffer.slice(0, chunkSize);
        buffer = buffer.slice(chunkSize);
        toCliPipe.write(chunkToSend);
      }
    }
  }
  streamPipeToCli(proc.stdout);
  streamPipeToCli(proc.stderr);

  const toLauncherPipeFile = Bun.file(toLauncherPipePath);

  const stream = toLauncherPipeFile.stream();
  async function readFromPipe(reader: ReadableStreamDefaultReader<Uint8Array>) {
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += new TextDecoder().decode(value);
      let eolIndex;

      while ((eolIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, eolIndex).trim();
        buffer = buffer.slice(eolIndex + 1);
        if (line) {
          try {
            if (line === "exit command") {
              // Receive kill command from cli (likely did cmd+c in terminal running the cli)
              process.kill(process.pid, "SIGINT");
            }
            const event = JSON.parse(line);
            // handler(event)
          } catch (error) {
            // Non-json things are just bubbled up to the console.
            console.error("launcher received line from cli: ", line);
          }
        }
      }
    }
  }

  // Call the async function to ensure it runs non-blocking
  const reader = stream.getReader();
  readFromPipe(reader);
  // streamPipeToCli(process.stdout);
  // streamPipeToCli(proc.stderr);
}

function getConfig() {
  let loadedConfig = {};
  if (existsSync(configPath)) {
    const configFileContents = readFileSync(configPath, "utf8");
    // Note: we want this to hard fail if there's a syntax error
    loadedConfig = JSON.parse(configFileContents);
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
  if (!config.build.mac.codesign) {
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
  if (!config.build.mac.notarize) {
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
  // todo (yoav): check if folders exist already before creating them
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
}
