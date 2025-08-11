import { join, dirname, basename } from "path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmdirSync,
  mkdirSync,
  createWriteStream,
  unlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  statSync,
  copyFileSync,
} from "fs";
import { execSync } from "child_process";
import tar from "tar";
import archiver from "archiver";
import { ZstdInit } from "@oneidentity/zstd-js/wasm";
import { OS, ARCH } from '../shared/platform';
import { getTemplate, getTemplateNames } from './templates/embedded';
// import { loadBsdiff, loadBspatch } from 'bsdiff-wasm';
// MacOS named pipes hang at around 4KB
const MAX_CHUNK_SIZE = 1024 * 2;


// const binExt = OS === 'win' ? '.exe' : '';

// this when run as an npm script this will be where the folder where package.json is.
const projectRoot = process.cwd();
const configName = "electrobun.config";
const configPath = join(projectRoot, configName);

// Note: cli args can be called via npm bun /path/to/electorbun/binary arg1 arg2
const indexOfElectrobun = process.argv.findIndex((arg) =>
  arg.includes("electrobun")
);
const commandArg = process.argv[indexOfElectrobun + 1] || "build";

const ELECTROBUN_DEP_PATH = join(projectRoot, "node_modules", "electrobun");

// When debugging electrobun with the example app use the builds (dev or release) right from the source folder
// For developers using electrobun cli via npm use the release versions in /dist
// This lets us not have to commit src build folders to git and provide pre-built binaries

// Function to get platform-specific paths
function getPlatformPaths(targetOS: 'macos' | 'win' | 'linux', targetArch: 'arm64' | 'x64') {
  const binExt = targetOS === 'win' ? '.exe' : '';
  const platformDistDir = join(ELECTROBUN_DEP_PATH, `dist-${targetOS}-${targetArch}`);
  const sharedDistDir = join(ELECTROBUN_DEP_PATH, "dist");
  
  return {
    // Platform-specific binaries (from dist-OS-ARCH/)
    BUN_BINARY: join(platformDistDir, "bun") + binExt,
    LAUNCHER_DEV: join(platformDistDir, "electrobun") + binExt,
    LAUNCHER_RELEASE: join(platformDistDir, "launcher") + binExt,
    NATIVE_WRAPPER_MACOS: join(platformDistDir, "libNativeWrapper.dylib"),
    NATIVE_WRAPPER_WIN: join(platformDistDir, "libNativeWrapper.dll"),
    NATIVE_WRAPPER_LINUX: join(platformDistDir, "libNativeWrapper.so"),
    NATIVE_WRAPPER_LINUX_CEF: join(platformDistDir, "libNativeWrapper_cef.so"),
    WEBVIEW2LOADER_WIN: join(platformDistDir, "WebView2Loader.dll"),
    BSPATCH: join(platformDistDir, "bspatch") + binExt,
    EXTRACTOR: join(platformDistDir, "extractor") + binExt,
    BSDIFF: join(platformDistDir, "bsdiff") + binExt,
    CEF_FRAMEWORK_MACOS: join(platformDistDir, "cef", "Chromium Embedded Framework.framework"),
    CEF_HELPER_MACOS: join(platformDistDir, "cef", "process_helper"),
    CEF_HELPER_WIN: join(platformDistDir, "cef", "process_helper.exe"),
    CEF_HELPER_LINUX: join(platformDistDir, "cef", "process_helper"),
    CEF_DIR: join(platformDistDir, "cef"),
    
    // Shared platform-independent files (from dist/)
    // These work with existing package.json and development workflow
    MAIN_JS: join(sharedDistDir, "main.js"),
    API_DIR: join(sharedDistDir, "api"),
  };
}

// Default PATHS for host platform (backward compatibility)
const PATHS = getPlatformPaths(OS, ARCH);

async function ensureCoreDependencies(targetOS?: 'macos' | 'win' | 'linux', targetArch?: 'arm64' | 'x64') {
  // Use provided target platform or default to host platform
  const platformOS = targetOS || OS;
  const platformArch = targetArch || ARCH;
  
  // Get platform-specific paths
  const platformPaths = getPlatformPaths(platformOS, platformArch);
  
  // Check platform-specific binaries
  const requiredBinaries = [
    platformPaths.BUN_BINARY,
    platformPaths.LAUNCHER_RELEASE,
    // Platform-specific native wrapper
    platformOS === 'macos' ? platformPaths.NATIVE_WRAPPER_MACOS :
    platformOS === 'win' ? platformPaths.NATIVE_WRAPPER_WIN :
    platformPaths.NATIVE_WRAPPER_LINUX
  ];
  
  // Check shared files (main.js should be in shared dist/)
  const requiredSharedFiles = [
    platformPaths.MAIN_JS
  ];
  
  const missingBinaries = requiredBinaries.filter(file => !existsSync(file));
  const missingSharedFiles = requiredSharedFiles.filter(file => !existsSync(file));
  
  // If only shared files are missing, that's expected in production (they come via npm)
  if (missingBinaries.length === 0 && missingSharedFiles.length > 0) {
    console.log(`Shared files missing (expected in production): ${missingSharedFiles.map(f => f.replace(ELECTROBUN_DEP_PATH, '.')).join(', ')}`);
  }
  
  // Only download if platform-specific binaries are missing
  if (missingBinaries.length === 0) {
    return;
  }

  // Show which binaries are missing
  console.log(`Core dependencies not found for ${platformOS}-${platformArch}. Missing files:`, missingBinaries.map(f => f.replace(ELECTROBUN_DEP_PATH, '.')).join(', '));
  console.log(`Downloading core binaries for ${platformOS}-${platformArch}...`);
  
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

  const platformName = platformOS === 'macos' ? 'darwin' : platformOS === 'win' ? 'win' : 'linux';
  const archName = platformArch;
  const coreTarballUrl = `https://github.com/blackboardsh/electrobun/releases/download/${version}/electrobun-core-${platformName}-${archName}.tar.gz`;
  
  console.log(`Downloading core binaries from: ${coreTarballUrl}`);
  
  try {
    // Download core binaries tarball
    const response = await fetch(coreTarballUrl);
    if (!response.ok) {
      throw new Error(`Failed to download binaries: ${response.status} ${response.statusText}`);
    }
    
    // Create temp file
    const tempFile = join(ELECTROBUN_DEP_PATH, `core-${platformOS}-${platformArch}-temp.tar.gz`);
    const fileStream = createWriteStream(tempFile);
    
    // Write response to file
    if (response.body) {
      const reader = response.body.getReader();
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buffer = Buffer.from(value);
        fileStream.write(buffer);
        totalBytes += buffer.length;
      }
      console.log(`Downloaded ${totalBytes} bytes for ${platformOS}-${platformArch}`);
    }
    
    // Ensure file is properly closed before proceeding
    await new Promise((resolve, reject) => {
      fileStream.end((err) => {
        if (err) reject(err);
        else resolve(null);
      });
    });
    
    // Verify the downloaded file exists and has content
    if (!existsSync(tempFile)) {
      throw new Error(`Downloaded file not found: ${tempFile}`);
    }
    
    const fileSize = require('fs').statSync(tempFile).size;
    if (fileSize === 0) {
      throw new Error(`Downloaded file is empty: ${tempFile}`);
    }
    
    console.log(`Verified download: ${tempFile} (${fileSize} bytes)`);
    
    // Extract to platform-specific dist directory
    console.log(`Extracting core dependencies for ${platformOS}-${platformArch}...`);
    const platformDistPath = join(ELECTROBUN_DEP_PATH, `dist-${platformOS}-${platformArch}`);
    mkdirSync(platformDistPath, { recursive: true });
    
    // Use Windows native tar.exe on Windows due to npm tar library issues
    if (OS === 'win') {
      console.log('Using Windows native tar.exe for reliable extraction...');
      execSync(`tar -xf "${tempFile}" -C "${platformDistPath}"`, { 
        stdio: 'inherit',
        cwd: platformDistPath 
      });
    } else {
      await tar.x({
        file: tempFile,
        cwd: platformDistPath,
        preservePaths: false,
        strip: 0,
      });
    }
    
    // NOTE: We no longer copy main.js from platform-specific downloads
    // Platform-specific downloads should only contain native binaries
    // main.js and api/ should be shipped via npm in the shared dist/ folder
    
    // Clean up temp file
    unlinkSync(tempFile);
    
    // Debug: List what was actually extracted
    try {
      const extractedFiles = readdirSync(platformDistPath);
      console.log(`Extracted files to ${platformDistPath}:`, extractedFiles);
      
      // Check if files are in subdirectories
      for (const file of extractedFiles) {
        const filePath = join(platformDistPath, file);
        const stat = require('fs').statSync(filePath);
        if (stat.isDirectory()) {
          const subFiles = readdirSync(filePath);
          console.log(`  ${file}/: ${subFiles.join(', ')}`);
        }
      }
    } catch (e) {
      console.error('Could not list extracted files:', e);
    }
    
    // Verify extraction completed successfully - check platform-specific binaries only
    const requiredBinaries = [
      platformPaths.BUN_BINARY,
      platformPaths.LAUNCHER_RELEASE,
      platformOS === 'macos' ? platformPaths.NATIVE_WRAPPER_MACOS :
      platformOS === 'win' ? platformPaths.NATIVE_WRAPPER_WIN :
      platformPaths.NATIVE_WRAPPER_LINUX
    ];
    
    const missingBinaries = requiredBinaries.filter(file => !existsSync(file));
    if (missingBinaries.length > 0) {
      console.error(`Missing binaries after extraction: ${missingBinaries.map(f => f.replace(ELECTROBUN_DEP_PATH, '.')).join(', ')}`);
      console.error('This suggests the tarball structure is different than expected');
    }
    
    // For development: if main.js doesn't exist in shared dist/, copy from platform-specific download as fallback
    const sharedDistPath = join(ELECTROBUN_DEP_PATH, 'dist');
    const extractedMainJs = join(platformDistPath, 'main.js');
    const sharedMainJs = join(sharedDistPath, 'main.js');
    
    if (existsSync(extractedMainJs) && !existsSync(sharedMainJs)) {
      console.log('Development fallback: copying main.js from platform-specific download to shared dist/');
      mkdirSync(sharedDistPath, { recursive: true });
      cpSync(extractedMainJs, sharedMainJs);
    }
    
    console.log(`Core dependencies for ${platformOS}-${platformArch} downloaded and cached successfully`);
    
  } catch (error: any) {
    console.error(`Failed to download core dependencies for ${platformOS}-${platformArch}:`, error.message);
    console.error('Please ensure you have an internet connection and the release exists.');
    process.exit(1);
  }
}

async function ensureCEFDependencies(targetOS?: 'macos' | 'win' | 'linux', targetArch?: 'arm64' | 'x64') {
  // Use provided target platform or default to host platform
  const platformOS = targetOS || OS;
  const platformArch = targetArch || ARCH;
  
  // Get platform-specific paths
  const platformPaths = getPlatformPaths(platformOS, platformArch);
  
  // Check if CEF dependencies already exist
  if (existsSync(platformPaths.CEF_DIR)) {
    console.log(`CEF dependencies found for ${platformOS}-${platformArch}, using cached version`);
    return;
  }

  console.log(`CEF dependencies not found for ${platformOS}-${platformArch}, downloading...`);
  
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

  const platformName = platformOS === 'macos' ? 'darwin' : platformOS === 'win' ? 'win' : 'linux';
  const archName = platformArch;
  const cefTarballUrl = `https://github.com/blackboardsh/electrobun/releases/download/${version}/electrobun-cef-${platformName}-${archName}.tar.gz`;
  
  console.log(`Downloading CEF from: ${cefTarballUrl}`);
  
  try {
    // Download CEF tarball
    const response = await fetch(cefTarballUrl);
    if (!response.ok) {
      throw new Error(`Failed to download CEF: ${response.status} ${response.statusText}`);
    }
    
    // Create temp file
    const tempFile = join(ELECTROBUN_DEP_PATH, `cef-${platformOS}-${platformArch}-temp.tar.gz`);
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
    
    // Extract to platform-specific dist directory
    console.log(`Extracting CEF dependencies for ${platformOS}-${platformArch}...`);
    const platformDistPath = join(ELECTROBUN_DEP_PATH, `dist-${platformOS}-${platformArch}`);
    mkdirSync(platformDistPath, { recursive: true });
    
    // Use Windows native tar.exe on Windows due to npm tar library issues
    if (OS === 'win') {
      console.log('Using Windows native tar.exe for reliable extraction...');
      execSync(`tar -xf "${tempFile}" -C "${platformDistPath}"`, { 
        stdio: 'inherit',
        cwd: platformDistPath 
      });
    } else {
      await tar.x({
        file: tempFile,
        cwd: platformDistPath,
        preservePaths: false,
        strip: 0,
      });
    }
    
    // Clean up temp file
    unlinkSync(tempFile);
    
    // Debug: List what was actually extracted for CEF
    try {
      const extractedFiles = readdirSync(platformDistPath);
      console.log(`CEF extracted files to ${platformDistPath}:`, extractedFiles);
      
      // Check if CEF directory was created
      const cefDir = join(platformDistPath, 'cef');
      if (existsSync(cefDir)) {
        const cefFiles = readdirSync(cefDir);
        console.log(`CEF directory contents: ${cefFiles.slice(0, 10).join(', ')}${cefFiles.length > 10 ? '...' : ''}`);
      }
    } catch (e) {
      console.error('Could not list CEF extracted files:', e);
    }
    
    console.log(`CEF dependencies for ${platformOS}-${platformArch} downloaded and cached successfully`);
    
  } catch (error: any) {
    console.error(`Failed to download CEF dependencies for ${platformOS}-${platformArch}:`, error.message);
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
    targets: undefined, // Will default to current platform if not specified
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
    win: {
      bundleCEF: false,
    },
    linux: {
      bundleCEF: false,
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
  process.argv.find((arg) => arg.startsWith("--env="))?.split("=")[1] || "";

const targetsArg =
  process.argv.find((arg) => arg.startsWith("--targets="))?.split("=")[1] || "";

const validEnvironments = ["dev", "canary", "stable"];

// todo (yoav): dev, canary, and stable;
const buildEnvironment: "dev" | "canary" | "stable" =
  validEnvironments.includes(envArg || "dev") ? (envArg || "dev") : "dev";

// Determine build targets
type BuildTarget = { os: 'macos' | 'win' | 'linux', arch: 'arm64' | 'x64' };

function parseBuildTargets(): BuildTarget[] {
  // If explicit targets provided via CLI
  if (targetsArg) {
    if (targetsArg === 'current') {
      return [{ os: OS, arch: ARCH }];
    } else if (targetsArg === 'all') {
      return parseConfigTargets();
    } else {
      // Parse comma-separated targets like "macos-arm64,win-x64"
      return targetsArg.split(',').map(target => {
        const [os, arch] = target.trim().split('-') as [string, string];
        if (!['macos', 'win', 'linux'].includes(os) || !['arm64', 'x64'].includes(arch)) {
          console.error(`Invalid target: ${target}. Format should be: os-arch (e.g., macos-arm64)`);
          process.exit(1);
        }
        return { os, arch } as BuildTarget;
      });
    }
  }

  // Default behavior: always build for current platform only
  // This ensures predictable, fast builds unless explicitly requesting multi-platform
  return [{ os: OS, arch: ARCH }];
}

function parseConfigTargets(): BuildTarget[] {
  // If config has targets, use them
  if (config.build.targets && config.build.targets.length > 0) {
    return config.build.targets.map(target => {
      if (target === 'current') {
        return { os: OS, arch: ARCH };
      }
      const [os, arch] = target.split('-') as [string, string];
      if (!['macos', 'win', 'linux'].includes(os) || !['arm64', 'x64'].includes(arch)) {
        console.error(`Invalid target in config: ${target}. Format should be: os-arch (e.g., macos-arm64)`);
        process.exit(1);
      }
      return { os, arch } as BuildTarget;
    });
  }
  
  // If no config targets and --targets=all, use all available platforms
  if (targetsArg === 'all') {
    console.log('No targets specified in config, using all available platforms');
    return [
      { os: 'macos', arch: 'arm64' },
      { os: 'macos', arch: 'x64' },
      { os: 'win', arch: 'x64' },
      { os: 'linux', arch: 'x64' },
      { os: 'linux', arch: 'arm64' }
    ];
  }
  
  // Default to current platform
  return [{ os: OS, arch: ARCH }];
}

const buildTargets = parseBuildTargets();

// Show build targets to user
if (buildTargets.length === 1) {
  console.log(`Building for ${buildTargets[0].os}-${buildTargets[0].arch} (${buildEnvironment})`);
} else {
  const targetList = buildTargets.map(t => `${t.os}-${t.arch}`).join(', ');
  console.log(`Building for multiple targets: ${targetList} (${buildEnvironment})`);
  console.log(`Running ${buildTargets.length} parallel builds...`);
  
  // Spawn parallel build processes
  const buildPromises = buildTargets.map(async (target) => {
    const targetString = `${target.os}-${target.arch}`;
    const prefix = `[${targetString}]`;
    
    try {
      // Try to find the electrobun binary in node_modules/.bin or use bunx
      const electrobunBin = join(projectRoot, 'node_modules', '.bin', 'electrobun');
      let command: string[];
      
      if (existsSync(electrobunBin)) {
        command = [electrobunBin, 'build', `--env=${buildEnvironment}`, `--targets=${targetString}`];
      } else {
        // Fallback to bunx which should resolve node_modules binaries
        command = ['bunx', 'electrobun', 'build', `--env=${buildEnvironment}`, `--targets=${targetString}`];
      }
      
      console.log(`${prefix} Running:`, command.join(' '));
      
      const result = await Bun.spawn(command, {
        stdio: ['inherit', 'pipe', 'pipe'],
        env: process.env,
        cwd: projectRoot // Ensure we're in the right directory
      });

      // Pipe output with prefix
      if (result.stdout) {
        const reader = result.stdout.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = new TextDecoder().decode(value);
          // Add prefix to each line
          const prefixedText = text.split('\n').map(line => 
            line ? `${prefix} ${line}` : line
          ).join('\n');
          process.stdout.write(prefixedText);
        }
      }

      if (result.stderr) {
        const reader = result.stderr.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = new TextDecoder().decode(value);
          const prefixedText = text.split('\n').map(line => 
            line ? `${prefix} ${line}` : line
          ).join('\n');
          process.stderr.write(prefixedText);
        }
      }

      const exitCode = await result.exited;
      return { target, exitCode, success: exitCode === 0 };
      
    } catch (error) {
      console.error(`${prefix} Failed to start build:`, error);
      return { target, exitCode: 1, success: false, error };
    }
  });

  // Wait for all builds to complete
  const results = await Promise.allSettled(buildPromises);
  
  // Report final results
  console.log('\n=== Build Results ===');
  let allSucceeded = true;
  
  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { target, success, exitCode } = result.value;
      const status = success ? '✅ SUCCESS' : '❌ FAILED';
      console.log(`${target.os}-${target.arch}: ${status} (exit code: ${exitCode})`);
      if (!success) allSucceeded = false;
    } else {
      console.log(`Build rejected: ${result.reason}`);
      allSucceeded = false;
    }
  }
  
  if (!allSucceeded) {
    console.log('\nSome builds failed. Check the output above for details.');
    process.exit(1);
  } else {
    console.log('\nAll builds completed successfully! 🎉');
  }
  
  process.exit(0);
}

// todo (yoav): dev builds should include the branch name, and/or allow configuration via external config
// For now, assume single target build (we'll refactor for multi-target later)
const currentTarget = buildTargets[0];
const buildSubFolder = `${buildEnvironment}-${currentTarget.os}-${currentTarget.arch}`;

// Use target OS/ARCH for build logic (instead of current machine's OS/ARCH)
const targetOS = currentTarget.os;
const targetARCH = currentTarget.arch;
const targetBinExt = targetOS === 'win' ? '.exe' : '';

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
const bundleFileName = targetOS === 'macos' ? `${appFileName}.app` : appFileName;

// const logPath = `/Library/Logs/Electrobun/ExampleApp/dev/out.log`;

let proc = null;

if (commandArg === "init") {
  const projectName = process.argv[indexOfElectrobun + 2] || "my-electrobun-app";
  const templateName = process.argv.find(arg => arg.startsWith("--template="))?.split("=")[1] || "hello-world";
  
  console.log(`🚀 Initializing Electrobun project: ${projectName}`);
  
  // Validate template name
  const availableTemplates = getTemplateNames();
  if (!availableTemplates.includes(templateName)) {
    console.error(`❌ Template "${templateName}" not found.`);
    console.log(`Available templates: ${availableTemplates.join(", ")}`);
    process.exit(1);
  }
  
  const template = getTemplate(templateName);
  if (!template) {
    console.error(`❌ Could not load template "${templateName}"`);
    process.exit(1);
  }
  
  // Create project directory
  const projectPath = join(process.cwd(), projectName);
  if (existsSync(projectPath)) {
    console.error(`❌ Directory "${projectName}" already exists.`);
    process.exit(1);
  }
  
  mkdirSync(projectPath, { recursive: true });
  
  // Extract template files
  let fileCount = 0;
  for (const [relativePath, content] of Object.entries(template.files)) {
    const fullPath = join(projectPath, relativePath);
    const dir = dirname(fullPath);
    
    // Create directory if it doesn't exist
    mkdirSync(dir, { recursive: true });
    
    // Write file
    writeFileSync(fullPath, content, 'utf-8');
    fileCount++;
  }
  
  console.log(`✅ Created ${fileCount} files from "${templateName}" template`);
  console.log(`📁 Project created at: ${projectPath}`);
  console.log("");
  console.log("📦 Next steps:");
  console.log(`   cd ${projectName}`);
  console.log("   bun install");
  console.log("   bunx electrobun dev");
  console.log("");
  console.log("🎉 Happy building with Electrobun!");
} else if (commandArg === "build") {
  // Ensure core binaries are available for the target platform before starting build
  await ensureCoreDependencies(currentTarget.os, currentTarget.arch);
  
  // Get platform-specific paths for the current target
  const targetPaths = getPlatformPaths(currentTarget.os, currentTarget.arch);
  
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
  } = createAppBundle(appFileName, buildFolder, targetOS);

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
  // Copy zig launcher for all builds (dev, canary, stable)
  const bunCliLauncherBinarySource = targetPaths.LAUNCHER_RELEASE;
  const bunCliLauncherDestination = join(appBundleMacOSPath, "launcher") + targetBinExt;
  const destLauncherFolder = dirname(bunCliLauncherDestination);
  if (!existsSync(destLauncherFolder)) {
    // console.info('creating folder: ', destFolder);
    mkdirSync(destLauncherFolder, { recursive: true });
  }

  cpSync(bunCliLauncherBinarySource, bunCliLauncherDestination, {
    recursive: true,
    dereference: true,
  });

  cpSync(targetPaths.MAIN_JS, join(appBundleFolderResourcesPath, 'main.js'));

  // Bun runtime binary
  // todo (yoav): this only works for the current architecture
  const bunBinarySourcePath = targetPaths.BUN_BINARY;
  // Note: .bin/bun binary in node_modules is a symlink to the versioned one in another place
  // in node_modules, so we have to dereference here to get the actual binary in the bundle.
  const bunBinaryDestInBundlePath = join(appBundleMacOSPath, "bun") + targetBinExt;
  const destFolder2 = dirname(bunBinaryDestInBundlePath);
  if (!existsSync(destFolder2)) {
    // console.info('creating folder: ', destFolder);
    mkdirSync(destFolder2, { recursive: true });
  }
  cpSync(bunBinarySourcePath, bunBinaryDestInBundlePath, { dereference: true });

  // copy native wrapper dynamic library
  if (targetOS === 'macos') {
  const nativeWrapperMacosSource = targetPaths.NATIVE_WRAPPER_MACOS;
  const nativeWrapperMacosDestination = join(
    appBundleMacOSPath,
    "libNativeWrapper.dylib"
  );  
  cpSync(nativeWrapperMacosSource, nativeWrapperMacosDestination, {
    dereference: true,
  });
} else if (targetOS === 'win') {
  const nativeWrapperMacosSource = targetPaths.NATIVE_WRAPPER_WIN;
  const nativeWrapperMacosDestination = join(
    appBundleMacOSPath,
    "libNativeWrapper.dll"
  );  
  cpSync(nativeWrapperMacosSource, nativeWrapperMacosDestination, {
    dereference: true,
  });

  const webview2LibSource = targetPaths.WEBVIEW2LOADER_WIN;
  const webview2LibDestination = join(
    appBundleMacOSPath,
    "WebView2Loader.dll"
  );  ;
  // copy webview2 system webview library
  cpSync(webview2LibSource, webview2LibDestination);
  
} else if (targetOS === 'linux') {
  // Choose the appropriate native wrapper based on bundleCEF setting
  const useCEF = config.build.linux?.bundleCEF;
  const nativeWrapperLinuxSource = useCEF ? targetPaths.NATIVE_WRAPPER_LINUX_CEF : targetPaths.NATIVE_WRAPPER_LINUX;
  const nativeWrapperLinuxDestination = join(
    appBundleMacOSPath,
    "libNativeWrapper.so"
  );
  
  if (existsSync(nativeWrapperLinuxSource)) {
    cpSync(nativeWrapperLinuxSource, nativeWrapperLinuxDestination, {
      dereference: true,
    });
    console.log(`Using ${useCEF ? 'CEF' : 'GTK'} native wrapper for Linux`);
  } else {
    throw new Error(`Native wrapper not found: ${nativeWrapperLinuxSource}`);
  }
}
  

  // Download CEF binaries if needed when bundleCEF is enabled
  if ((targetOS === 'macos' && config.build.mac?.bundleCEF) || 
      (targetOS === 'win' && config.build.win?.bundleCEF) || 
      (targetOS === 'linux' && config.build.linux?.bundleCEF)) {
    
    await ensureCEFDependencies(currentTarget.os, currentTarget.arch);    
    if (targetOS === 'macos') {
      const cefFrameworkSource = targetPaths.CEF_FRAMEWORK_MACOS;
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

      const helperSourcePath = targetPaths.CEF_HELPER_MACOS;
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
    } else if (targetOS === 'win') {
      // Copy CEF DLLs from platform-specific dist/cef/ to the main executable directory
      const cefSourcePath = targetPaths.CEF_DIR;
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
      const cefResourcesSource = targetPaths.CEF_DIR;
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

      const helperSourcePath = targetPaths.CEF_HELPER_WIN;
      if (existsSync(helperSourcePath)) {
        cefHelperNames.forEach((helperName) => {
          const destinationPath = join(appBundleMacOSPath, `${helperName}.exe`);
          cpSync(helperSourcePath, destinationPath);
          
        });
      } else {
        console.log(`WARNING: Missing CEF helper: ${helperSourcePath}`);
      }
    } else if (targetOS === 'linux') {
      // Copy CEF shared libraries from platform-specific dist/cef/ to the main executable directory
      const cefSourcePath = targetPaths.CEF_DIR;
      
      if (existsSync(cefSourcePath)) {
        const cefSoFiles = [
          'libcef.so',
          'libEGL.so',
          'libGLESv2.so',
          'libvk_swiftshader.so',
          'libvulkan.so.1'
        ];
        
        // Copy CEF .so files to main directory as symlinks to cef/ subdirectory
        cefSoFiles.forEach(soFile => {
          const sourcePath = join(cefSourcePath, soFile);
          const destPath = join(appBundleMacOSPath, soFile);
          if (existsSync(sourcePath)) {
            // We'll create the actual file in cef/ and symlink from main directory
            // This will be done after the cef/ directory is populated
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
        
        // Create symlinks from main directory to cef/ subdirectory for .so files
        console.log('Creating symlinks for CEF libraries...');
        cefSoFiles.forEach(soFile => {
          const cefFilePath = join(cefResourcesDestination, soFile);
          const mainDirPath = join(appBundleMacOSPath, soFile);
          
          if (existsSync(cefFilePath)) {
            try {
              // Remove any existing file/symlink in main directory
              if (existsSync(mainDirPath)) {
                rmSync(mainDirPath);
              }
              // Create symlink from main directory to cef/ subdirectory
              symlinkSync(join('cef', soFile), mainDirPath);
              console.log(`Created symlink for CEF library: ${soFile} -> cef/${soFile}`);
            } catch (error) {
              console.log(`WARNING: Failed to create symlink for ${soFile}: ${error}`);
              // Fallback to copying the file
              cpSync(cefFilePath, mainDirPath);
              console.log(`Fallback: Copied CEF library to main directory: ${soFile}`);
            }
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

        const helperSourcePath = targetPaths.CEF_HELPER_LINUX;
        if (existsSync(helperSourcePath)) {
          cefHelperNames.forEach((helperName) => {
            const destinationPath = join(appBundleMacOSPath, helperName);
            cpSync(helperSourcePath, destinationPath);
            // console.log(`Copied CEF helper: ${helperName}`);
          });
        } else {
          console.log(`WARNING: Missing CEF helper: ${helperSourcePath}`);
        }
      }
    }
  }


  // copy native bindings
  const bsPatchSource = targetPaths.BSPATCH;
  const bsPatchDestination = join(appBundleMacOSPath, "bspatch") + targetBinExt;
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
    // Use host platform's bun binary for running scripts, not target platform's
    const hostPaths = getPlatformPaths(OS, ARCH);
    
    Bun.spawnSync([hostPaths.BUN_BINARY, config.scripts.postBuild], {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        ELECTROBUN_BUILD_ENV: buildEnvironment,
        ELECTROBUN_OS: targetOS, // Use target OS for environment variables
        ELECTROBUN_ARCH: targetARCH, // Use target ARCH for environment variables
        ELECTROBUN_BUILD_DIR: buildFolder,
        ELECTROBUN_APP_NAME: appFileName,
        ELECTROBUN_APP_VERSION: config.app.version,
        ELECTROBUN_APP_IDENTIFIER: config.app.identifier,
        ELECTROBUN_ARTIFACT_DIR: artifactFolder,
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
  // Only codesign/notarize when building macOS targets on macOS host
  const shouldCodesign =
    buildEnvironment !== "dev" && targetOS === 'macos' && OS === 'macos' && config.build.mac.codesign;
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

    // Platform suffix is only used for folder names, not file names
    const platformSuffix = `-${targetOS}-${targetARCH}`;
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

    let compressedTarPath = `${tarPath}.zst`;
    artifactsToUpload.push(compressedTarPath);

    // zstd compress tarball
    // todo (yoav): consider using c bindings for zstd for speed instead of wasm
    // we already have it in the bsdiff binary
    console.log("compressing tarball...");
    await ZstdInit().then(async ({ ZstdSimple, ZstdStream }) => {
      // Note: Simple is much faster than stream, but stream is better for large files
      // todo (yoav): consider a file size cutoff to switch to stream instead of simple.
      const useStream = tarball.size > 100 * 1024 * 1024;
      
      if (tarball.size > 0) {
        // Uint8 array filestream of the tar file
        const data = new Uint8Array(tarBuffer);
        
        const compressionLevel = 22;  // Maximum compression - now safe with stripped CEF libraries
        const compressedData = ZstdSimple.compress(data, compressionLevel);

        console.log(
          "compressed",
          data.length,
          "bytes",
          "from",
          tarBuffer.byteLength,
          "bytes"
        );

        await Bun.write(compressedTarPath, compressedData);
      }
    });

    // we can delete the original app bundle since we've tarred and zstd it. We need to create the self-extracting app bundle
    // now and it needs the same name as the original app bundle.
    rmdirSync(appBundleFolderPath, { recursive: true });

    const selfExtractingBundle = createAppBundle(appFileName, buildFolder, targetOS);
    const compressedTarballInExtractingBundlePath = join(
      selfExtractingBundle.appBundleFolderResourcesPath,
      `${hash}.tar.zst`
    );

    // copy the zstd tarball to the self-extracting app bundle
    cpSync(compressedTarPath, compressedTarballInExtractingBundlePath);

    const selfExtractorBinSourcePath = targetPaths.EXTRACTOR;
    const selfExtractorBinDestinationPath = join(
      selfExtractingBundle.appBundleMacOSPath,
      "launcher"
    );

    cpSync(selfExtractorBinSourcePath, selfExtractorBinDestinationPath, {
      dereference: true,
    });

    buildIcons(selfExtractingBundle.appBundleFolderResourcesPath);
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

    // DMG creation for macOS only
    if (targetOS === 'macos') {
      console.log("creating dmg...");
      // make a dmg
      const dmgPath = join(buildFolder, `${appFileName}.dmg`);
      artifactsToUpload.push(dmgPath);
      // hdiutil create -volname "YourAppName" -srcfolder /path/to/YourApp.app -ov -format UDZO YourAppName.dmg
      // Note: use ULFO (lzfse) for better compatibility with large CEF frameworks and modern macOS
      execSync(
        `hdiutil create -volname "${appFileName}" -srcfolder ${escapePathForTerminal(
          selfExtractingBundle.appBundleFolderPath
        )} -ov -format ULFO ${escapePathForTerminal(dmgPath)}`
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
    } else {
      // For Windows and Linux, add the self-extracting bundle directly
      const platformBundlePath = join(buildFolder, `${appFileName}${platformSuffix}${targetOS === 'win' ? '.exe' : ''}`);
      // Copy the self-extracting bundle to platform-specific filename
      if (targetOS === 'win') {
        // On Windows, create a self-extracting exe
        const selfExtractingExePath = await createWindowsSelfExtractingExe(
          buildFolder,
          compressedTarPath,
          appFileName,
          targetPaths,
          buildEnvironment,
          hash
        );
        
        // Wrap Windows installer files in zip for distribution
        const wrappedExePath = await wrapWindowsInstallerInZip(selfExtractingExePath, buildFolder);
        artifactsToUpload.push(wrappedExePath);
        
        // Also keep the raw exe for backwards compatibility (optional)
        // artifactsToUpload.push(selfExtractingExePath);
      } else if (targetOS === 'linux') {
        // Create desktop file for Linux
        const desktopFileContent = `[Desktop Entry]
Version=1.0
Type=Application
Name=${config.package?.name || config.app.name}
Comment=${config.package?.description || config.app.description || ''}
Exec=${appFileName}
Icon=${appFileName}
Terminal=false
StartupWMClass=${appFileName}
Categories=Application;
`;
        
        const desktopFilePath = join(appBundleFolderPath, `${appFileName}.desktop`);
        writeFileSync(desktopFilePath, desktopFileContent);
        
        // Make desktop file executable
        execSync(`chmod +x ${escapePathForTerminal(desktopFilePath)}`);
        
        // Create user-friendly launcher script
        const launcherScriptContent = `#!/bin/bash
# ${config.package?.name || config.app.name} Launcher
# This script launches the application from any location

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"

# Find the launcher binary relative to this script
LAUNCHER_BINARY="\$SCRIPT_DIR/bin/launcher"

if [ ! -x "\$LAUNCHER_BINARY" ]; then
    echo "Error: Could not find launcher binary at \$LAUNCHER_BINARY"
    exit 1
fi

# Launch the application
exec "\$LAUNCHER_BINARY" "\$@"
`;
        
        const launcherScriptPath = join(appBundleFolderPath, `${appFileName}.sh`);
        writeFileSync(launcherScriptPath, launcherScriptContent);
        execSync(`chmod +x ${escapePathForTerminal(launcherScriptPath)}`);
        
        // Create self-extracting Linux binary (similar to Windows approach)
        const selfExtractingLinuxPath = await createLinuxSelfExtractingBinary(
          buildFolder,
          compressedTarPath,
          appFileName,
          targetPaths,
          buildEnvironment
        );
        
        // Wrap Linux .run file in tar.gz to preserve permissions
        const wrappedRunPath = await wrapInArchive(selfExtractingLinuxPath, buildFolder, 'tar.gz');
        artifactsToUpload.push(wrappedRunPath);
        
        // Also keep the raw .run for backwards compatibility (optional)
        // artifactsToUpload.push(selfExtractingLinuxPath);
        
        // On Linux, create a tar.gz of the bundle
        const linuxTarPath = join(buildFolder, `${appFileName}.tar.gz`);
        execSync(`tar -czf ${escapePathForTerminal(linuxTarPath)} -C ${escapePathForTerminal(buildFolder)} ${escapePathForTerminal(basename(appBundleFolderPath))}`);
        artifactsToUpload.push(linuxTarPath);
      }
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
      platform: OS,
      arch: ARCH,
      // channel: buildEnvironment,
      // bucketUrl: config.release.bucketUrl
    });

    // update.json (no platform suffix in filename, platform is in folder name)
    await Bun.write(join(artifactFolder, 'update.json'), updateJsonContent);

    // generate bsdiff
    // https://storage.googleapis.com/eggbun-static/electrobun-playground/canary/ElectrobunPlayground-canary.app.tar.zst
    console.log("bucketUrl: ", config.release.bucketUrl);

    console.log("generating a patch from the previous version...");
    
    // Skip patch generation if bucketUrl is not configured
    if (!config.release.bucketUrl || config.release.bucketUrl.trim() === '') {
      console.log("No bucketUrl configured, skipping patch generation");
      console.log("To enable patch generation, configure bucketUrl in your electrobun.config");
    } else {
      const urlToPrevUpdateJson = join(
        config.release.bucketUrl,
        buildSubFolder,
        'update.json'
      );
      const cacheBuster = Math.random().toString(36).substring(7);
      const updateJsonResponse = await fetch(
        urlToPrevUpdateJson + `?${cacheBuster}`
      ).catch((err) => {
        console.log("bucketURL not found: ", err);
      });

    const urlToLatestTarball = join(
      config.release.bucketUrl,
      buildSubFolder,
      `${appFileName}.app.tar.zst`
    );


    // attempt to get the previous version to create a patch file
    if (updateJsonResponse && updateJsonResponse.ok) {
      const prevUpdateJson = await updateJsonResponse!.json();

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
        const bsdiffpath = targetPaths.BSDIFF;
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
    } // End of bucketUrl validation block

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
  // this runs the bundled bun binary with main.js directly

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
  let bundleResourcesPath: string;
  
  if (OS === 'macos') {
    bundleExecPath = join(buildFolder, bundleFileName, "Contents", 'MacOS');
    bundleResourcesPath = join(buildFolder, bundleFileName, "Contents", 'Resources');
  } else if (OS === 'linux' || OS === 'win') {
    bundleExecPath = join(buildFolder, bundleFileName, "bin");
    bundleResourcesPath = join(buildFolder, bundleFileName, "Resources");
  } else {
    throw new Error(`Unsupported OS: ${OS}`);
  }

  if (OS === 'macos') {
    // Use the zig launcher for all builds (dev, canary, stable)
    mainProc = Bun.spawn([join(bundleExecPath, 'launcher')], {
      stdio: ['inherit', 'inherit', 'inherit'],
      cwd: bundleExecPath
    })
  } else if (OS === 'win') {  
    // Try the main process - use relative path to Resources folder
    mainProc =  Bun.spawn(['./bun.exe', '../Resources/main.js'], {
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
    
    mainProc = Bun.spawn([join(bundleExecPath, 'bun'), join(bundleResourcesPath, 'main.js')], {
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

async function createWindowsSelfExtractingExe(
  buildFolder: string,
  compressedTarPath: string,
  appFileName: string,
  targetPaths: any,
  buildEnvironment: string,
  hash: string
): Promise<string> {
  console.log("Creating Windows installer with separate archive...");
  
  // Format: MyApp-Setup.exe (stable) or MyApp-Setup-canary.exe (non-stable)
  const setupFileName = buildEnvironment === "stable" 
    ? `${config.app.name}-Setup.exe`
    : `${config.app.name}-Setup-${buildEnvironment}.exe`;
  
  const outputExePath = join(buildFolder, setupFileName);
  
  // Copy the extractor exe
  const extractorExe = readFileSync(targetPaths.EXTRACTOR);
  writeFileSync(outputExePath, extractorExe);
  
  // Create metadata JSON file
  const metadata = {
    identifier: config.app.identifier,
    name: config.app.name,
    channel: buildEnvironment,
    hash: hash
  };
  const metadataJson = JSON.stringify(metadata, null, 2);
  const metadataFileName = setupFileName.replace('.exe', '.metadata.json');
  const metadataPath = join(buildFolder, metadataFileName);
  writeFileSync(metadataPath, metadataJson);
  
  // Copy the compressed archive with matching name
  const archiveFileName = setupFileName.replace('.exe', '.tar.zst');
  const archivePath = join(buildFolder, archiveFileName);
  copyFileSync(compressedTarPath, archivePath);
  
  // Make the exe executable (though Windows doesn't need chmod)
  if (OS !== 'win') {
    execSync(`chmod +x ${escapePathForTerminal(outputExePath)}`);
  }
  
  const exeSize = statSync(outputExePath).size;
  const archiveSize = statSync(archivePath).size;
  const totalSize = exeSize + archiveSize;
  
  console.log(`Created Windows installer:`);
  console.log(`  - Extractor: ${outputExePath} (${(exeSize / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`  - Archive: ${archivePath} (${(archiveSize / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`  - Metadata: ${metadataPath}`);
  console.log(`  - Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
  
  return outputExePath;
}

async function createLinuxSelfExtractingBinary(
  buildFolder: string,
  compressedTarPath: string,
  appFileName: string,
  targetPaths: any,
  buildEnvironment: string
): Promise<string> {
  console.log("Creating self-extracting Linux binary...");
  
  // Format: MyApp-Setup.run (stable) or MyApp-Setup-canary.run (non-stable)
  const setupFileName = buildEnvironment === "stable" 
    ? `${config.app.name}-Setup.run`
    : `${config.app.name}-Setup-${buildEnvironment}.run`;
  
  const outputPath = join(buildFolder, setupFileName);
  
  // Read the extractor binary
  const extractorBinary = readFileSync(targetPaths.EXTRACTOR);
  
  // Read the compressed archive
  const compressedArchive = readFileSync(compressedTarPath);
  
  // Create metadata JSON
  const metadata = {
    identifier: config.app.identifier,
    name: config.app.name,
    channel: buildEnvironment
  };
  const metadataJson = JSON.stringify(metadata);
  const metadataBuffer = Buffer.from(metadataJson, 'utf8');
  
  // Create marker buffers
  const metadataMarker = Buffer.from('ELECTROBUN_METADATA_V1', 'utf8');
  const archiveMarker = Buffer.from('ELECTROBUN_ARCHIVE_V1', 'utf8');
  
  // Combine extractor + metadata marker + metadata + archive marker + archive
  const combinedBuffer = Buffer.concat([
    extractorBinary,
    metadataMarker,
    metadataBuffer,
    archiveMarker,
    compressedArchive
  ]);
  
  // Write the self-extracting binary
  writeFileSync(outputPath, combinedBuffer, { mode: 0o755 });
  
  // Ensure it's executable (redundant but explicit)
  execSync(`chmod +x ${escapePathForTerminal(outputPath)}`);
  
  console.log(`Created self-extracting Linux binary: ${outputPath} (${(combinedBuffer.length / 1024 / 1024).toFixed(2)} MB)`);
  
  return outputPath;
}

async function wrapWindowsInstallerInZip(exePath: string, buildFolder: string): Promise<string> {
  const exeName = basename(exePath);
  const exeStem = exeName.replace('.exe', '');
  
  // Derive the paths for metadata and archive files
  const metadataPath = join(buildFolder, `${exeStem}.metadata.json`);
  const archivePath = join(buildFolder, `${exeStem}.tar.zst`);
  const zipPath = join(buildFolder, `${exeStem}.zip`);
  
  // Verify all files exist
  if (!existsSync(exePath)) {
    throw new Error(`Installer exe not found: ${exePath}`);
  }
  if (!existsSync(metadataPath)) {
    throw new Error(`Metadata file not found: ${metadataPath}`);
  }
  if (!existsSync(archivePath)) {
    throw new Error(`Archive file not found: ${archivePath}`);
  }
  
  // Create zip archive
  const output = createWriteStream(zipPath);
  const archive = archiver('zip', {
    zlib: { level: 9 } // Maximum compression
  });
  
  return new Promise((resolve, reject) => {
    output.on('close', () => {
      console.log(`Created Windows installer package: ${zipPath} (${(archive.pointer() / 1024 / 1024).toFixed(2)} MB)`);
      resolve(zipPath);
    });
    
    archive.on('error', (err) => {
      reject(err);
    });
    
    archive.pipe(output);
    
    // Add all three files to the archive
    archive.file(exePath, { name: basename(exePath) });
    archive.file(metadataPath, { name: basename(metadataPath) });
    archive.file(archivePath, { name: basename(archivePath) });
    
    archive.finalize();
  });
}

async function wrapInArchive(filePath: string, buildFolder: string, archiveType: 'tar.gz' | 'zip'): Promise<string> {
  const fileName = basename(filePath);
  const fileDir = dirname(filePath);
  
  if (archiveType === 'tar.gz') {
    // Output filename: Setup.exe -> Setup.exe.tar.gz or Setup.run -> Setup.run.tar.gz
    const archivePath = filePath + '.tar.gz';
    
    // For Linux files, ensure they have executable permissions before archiving
    if (fileName.endsWith('.run')) {
      try {
        // Try to set executable permissions (will only work on Unix-like systems)
        execSync(`chmod +x ${escapePathForTerminal(filePath)}`, { stdio: 'ignore' });
      } catch {
        // Ignore errors on Windows hosts
      }
    }
    
    // Create tar.gz archive preserving permissions
    // Using the tar package for cross-platform compatibility
    await tar.c(
      {
        gzip: true,
        file: archivePath,
        cwd: fileDir,
        portable: true,  // Ensures consistent behavior across platforms
        preservePaths: false,
        // The tar package should preserve file modes when creating archives
      },
      [fileName]
    );
    
    console.log(`Created archive: ${archivePath} (preserving executable permissions)`);
    return archivePath;
  } else if (archiveType === 'zip') {
    // Output filename: Setup.exe -> Setup.zip
    const archivePath = filePath.replace(/\.[^.]+$/, '.zip');
    
    // Create zip archive
    const output = createWriteStream(archivePath);
    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });
    
    return new Promise((resolve, reject) => {
      output.on('close', () => {
        console.log(`Created archive: ${archivePath} (${(archive.pointer() / 1024 / 1024).toFixed(2)} MB)`);
        resolve(archivePath);
      });
      
      archive.on('error', (err) => {
        reject(err);
      });
      
      archive.pipe(output);
      
      // Add the file to the archive
      archive.file(filePath, { name: fileName });
      
      archive.finalize();
    });
  }
}

async function createAppImage(buildFolder: string, appBundlePath: string, appFileName: string, config: any): Promise<string | null> {
  try {
    console.log("Creating AppImage...");
    
    // Create AppDir structure
    const appDirPath = join(buildFolder, `${appFileName}.AppDir`);
    mkdirSync(appDirPath, { recursive: true });
    
    // Copy app bundle contents to AppDir
    const appDirAppPath = join(appDirPath, "app");
    cpSync(appBundlePath, appDirAppPath, { recursive: true });
    
    // Create AppRun script (main executable for AppImage)
    const appRunContent = `#!/bin/bash
HERE="$(dirname "$(readlink -f "\${0}")")"
export APPDIR="\$HERE"
cd "\$HERE"
exec "\$HERE/app/bin/launcher" "\$@"
`;
    
    const appRunPath = join(appDirPath, "AppRun");
    writeFileSync(appRunPath, appRunContent);
    execSync(`chmod +x ${escapePathForTerminal(appRunPath)}`);
    
    // Create desktop file in AppDir root
    const desktopContent = `[Desktop Entry]
Version=1.0
Type=Application
Name=${config.package?.name || config.app.name}
Comment=${config.package?.description || config.app.description || ''}
Exec=AppRun
Icon=${appFileName}
Terminal=false
StartupWMClass=${appFileName}
Categories=Application;
`;
    
    const appDirDesktopPath = join(appDirPath, `${appFileName}.desktop`);
    writeFileSync(appDirDesktopPath, desktopContent);
    
    // Copy icon if it exists
    const iconPath = config.build.linux?.appImageIcon;
    if (iconPath && existsSync(iconPath)) {
      const iconDestPath = join(appDirPath, `${appFileName}.png`);
      cpSync(iconPath, iconDestPath);
    }
    
    // Try to create AppImage using available tools
    const appImagePath = join(buildFolder, `${appFileName}.AppImage`);
    
    // Check for appimagetool
    try {
      execSync('which appimagetool', { stdio: 'pipe' });
      console.log("Using appimagetool to create AppImage...");
      execSync(`appimagetool ${escapePathForTerminal(appDirPath)} ${escapePathForTerminal(appImagePath)}`, { stdio: 'inherit' });
      return appImagePath;
    } catch {
      // Check for Docker
      try {
        execSync('which docker', { stdio: 'pipe' });
        console.log("Using Docker to create AppImage...");
        execSync(`docker run --rm -v "${buildFolder}:/workspace" linuxserver/appimagetool "/workspace/${basename(appDirPath)}" "/workspace/${basename(appImagePath)}"`, { stdio: 'inherit' });
        return appImagePath;
      } catch {
        console.warn("Neither appimagetool nor Docker found. AppImage creation skipped.");
        console.warn("To create AppImages, install appimagetool or Docker.");
        return null;
      }
    }
  } catch (error) {
    console.error("Failed to create AppImage:", error);
    return null;
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

  // If this is a DMG file, sign it directly
  if (appBundleOrDmgPath.endsWith('.dmg')) {
    execSync(
      `codesign --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" ${escapePathForTerminal(
        appBundleOrDmgPath
      )}`
    );
    return;
  }

  // For app bundles, sign binaries individually to avoid --deep issues with notarization
  const contentsPath = join(appBundleOrDmgPath, 'Contents');
  const macosPath = join(contentsPath, 'MacOS');
  
  // Prepare entitlements if provided
  if (entitlementsFilePath) {
    const entitlementsFileContents = buildEntitlementsFile(
      config.build.mac.entitlements
    );
    Bun.write(entitlementsFilePath, entitlementsFileContents);
  }

  // Sign frameworks first (CEF framework if it exists)
  const frameworksPath = join(contentsPath, 'Frameworks');
  if (existsSync(frameworksPath)) {
    try {
      const frameworks = readdirSync(frameworksPath);
      for (const framework of frameworks) {
        if (framework.endsWith('.framework')) {
          const frameworkPath = join(frameworksPath, framework);
          console.log(`Signing framework: ${framework}`);
          execSync(
            `codesign --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" --options runtime ${escapePathForTerminal(frameworkPath)}`
          );
        }
      }
    } catch (err) {
      console.log("No frameworks to sign or error signing frameworks:", err);
    }
  }

  // Sign individual binaries in MacOS folder with their proper identifiers
  const binariesToSign = [
    { file: 'bun', identifier: 'bun' },
    { file: 'extractor', identifier: 'extractor' },
    { file: 'bsdiff', identifier: 'bsdiff' },
    { file: 'bspatch', identifier: 'bspatch' },
    { file: 'libNativeWrapper.dylib', identifier: 'libNativeWrapper.dylib' }
  ];

  for (const binary of binariesToSign) {
    const binaryPath = join(macosPath, binary.file);
    if (existsSync(binaryPath)) {
      console.log(`Signing ${binary.file} with identifier ${binary.identifier}`);
      const entitlementFlag = entitlementsFilePath ? `--entitlements ${entitlementsFilePath}` : '';
      execSync(
        `codesign --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" --options runtime --identifier ${binary.identifier} ${entitlementFlag} ${escapePathForTerminal(binaryPath)}`
      );
    }
  }

  // Note: main.js is now in Resources and will be automatically sealed when signing the app bundle
  
  // Sign the main executable (launcher) - this should use the app's bundle identifier, not "launcher"
  const launcherPath = join(macosPath, 'launcher');
  if (existsSync(launcherPath)) {
    console.log("Signing main executable (launcher)");
    const entitlementFlag = entitlementsFilePath ? `--entitlements ${entitlementsFilePath}` : '';
    try {
      execSync(
        `codesign --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" --options runtime ${entitlementFlag} ${escapePathForTerminal(launcherPath)}`
      );
    } catch (error) {
      console.error("Failed to sign launcher:", error.message);
      console.log("Attempting to sign launcher without runtime hardening...");
      execSync(
        `codesign --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" ${entitlementFlag} ${escapePathForTerminal(launcherPath)}`
      );
    }
  }

  // Finally, sign the app bundle itself (without --deep)
  console.log("Signing app bundle");
  const entitlementFlag = entitlementsFilePath ? `--entitlements ${entitlementsFilePath}` : '';
  execSync(
    `codesign --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" --options runtime ${entitlementFlag} ${escapePathForTerminal(appBundleOrDmgPath)}`
  );
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
function createAppBundle(bundleName: string, parentFolder: string, targetOS: 'macos' | 'win' | 'linux') {
  if (targetOS === 'macos') {
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
  } else if (targetOS === 'linux' || targetOS === 'win') {
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
    throw new Error(`Unsupported OS: ${targetOS}`);
  }
}
