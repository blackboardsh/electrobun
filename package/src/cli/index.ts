import { join, dirname, basename, relative } from "path";
import * as path from "path";
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
  renameSync,
} from "fs";
import { execSync } from "child_process";
import * as readline from "readline";
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

// Find TypeScript ESM config file
function findConfigFile(): string | null {
  const configFile = join(projectRoot, 'electrobun.config.ts');
  return existsSync(configFile) ? configFile : null;
}

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
    platformPaths.BUN_BINARY
  ];
  if (platformOS === 'macos') {
    requiredBinaries.push(
      platformPaths.LAUNCHER_RELEASE,
      platformPaths.NATIVE_WRAPPER_MACOS
    );
  } else if (platformOS === 'win') {
    requiredBinaries.push(platformPaths.NATIVE_WRAPPER_WIN);
  } else {
    requiredBinaries.push(platformPaths.NATIVE_WRAPPER_LINUX);
  }
  
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
      const relativeTempFile = relative(platformDistPath, tempFile);
      execSync(`tar -xf "${relativeTempFile}"`, { 
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
    const requiredBinaries = [platformPaths.BUN_BINARY];
    if (platformOS === 'macos') {
      requiredBinaries.push(
        platformPaths.LAUNCHER_RELEASE,
        platformPaths.NATIVE_WRAPPER_MACOS
      );
    } else if (platformOS === 'win') {
      requiredBinaries.push(platformPaths.NATIVE_WRAPPER_WIN);
    } else {
      requiredBinaries.push(platformPaths.NATIVE_WRAPPER_LINUX);
    }
    
    const missingBinaries = requiredBinaries.filter(file => !existsSync(file));
    if (missingBinaries.length > 0) {
      console.error(`Missing binaries after extraction: ${missingBinaries.map(f => f.replace(ELECTROBUN_DEP_PATH, '.')).join(', ')}`);
      console.error('This suggests the tarball structure is different than expected');
    }
    
    // Note: We no longer need to remove or re-add signatures from downloaded binaries
    // The CI-added adhoc signatures are actually required for macOS to run the binaries
    
    // For development: if main.js doesn't exist in shared dist/, copy from platform-specific download as fallback
    const sharedDistPath = join(ELECTROBUN_DEP_PATH, 'dist');
    const extractedMainJs = join(platformDistPath, 'main.js');
    const sharedMainJs = join(sharedDistPath, 'main.js');
    
    if (existsSync(extractedMainJs) && !existsSync(sharedMainJs)) {
      console.log('Development fallback: copying main.js from platform-specific download to shared dist/');
      mkdirSync(sharedDistPath, { recursive: true });
      cpSync(extractedMainJs, sharedMainJs, { dereference: true });
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
  
  // Helper function to download with retry logic
  async function downloadWithRetry(url: string, filePath: string, maxRetries = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Downloading CEF (attempt ${attempt}/${maxRetries}) from: ${url}`);
        
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        // Get content length for progress tracking
        const contentLength = response.headers.get('content-length');
        const totalSize = contentLength ? parseInt(contentLength, 10) : 0;
        
        // Create temp file with unique name to avoid conflicts
        const fileStream = createWriteStream(filePath);
        let downloadedSize = 0;
        let lastReportedPercent = -1;
        
        // Stream download with progress
        if (response.body) {
          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = Buffer.from(value);
            fileStream.write(chunk);
            downloadedSize += chunk.length;
            
            if (totalSize > 0) {
              const percent = Math.round((downloadedSize / totalSize) * 100);
              const percentTier = Math.floor(percent / 10) * 10;
              if (percentTier > lastReportedPercent && percentTier <= 100) {
                console.log(`  Progress: ${percentTier}% (${Math.round(downloadedSize / 1024 / 1024)}MB/${Math.round(totalSize / 1024 / 1024)}MB)`);
                lastReportedPercent = percentTier;
              }
            }
          }
        }
        
        await new Promise((resolve, reject) => {
          fileStream.end((error: any) => {
            if (error) reject(error);
            else resolve(void 0);
          });
        });
        
        // Verify file size if content-length was provided
        if (totalSize > 0) {
          const actualSize = (await import('fs')).statSync(filePath).size;
          if (actualSize !== totalSize) {
            throw new Error(`Downloaded file size mismatch: expected ${totalSize}, got ${actualSize}`);
          }
        }
        
        console.log(`✓ Download completed successfully (${Math.round(downloadedSize / 1024 / 1024)}MB)`);
        return; // Success, exit retry loop
        
      } catch (error: any) {
        console.error(`Download attempt ${attempt} failed:`, error.message);
        
        // Clean up partial download
        if (existsSync(filePath)) {
          unlinkSync(filePath);
        }
        
        if (attempt === maxRetries) {
          throw new Error(`Failed to download after ${maxRetries} attempts: ${error.message}`);
        }
        
        // Wait before retrying (exponential backoff)
        const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s...
        console.log(`Retrying in ${delay / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  try {
    // Create temp file with unique name
    const tempFile = join(ELECTROBUN_DEP_PATH, `cef-${platformOS}-${platformArch}-${Date.now()}.tar.gz`);
    
    // Download with retry logic
    await downloadWithRetry(cefTarballUrl, tempFile);
    
    // Extract to platform-specific dist directory
    console.log(`Extracting CEF dependencies for ${platformOS}-${platformArch}...`);
    const platformDistPath = join(ELECTROBUN_DEP_PATH, `dist-${platformOS}-${platformArch}`);
    mkdirSync(platformDistPath, { recursive: true });
    
    // Helper function to validate tar file before extraction
    async function validateTarFile(filePath: string): Promise<void> {
      try {
        // Quick validation - try to read the tar file header
        const fd = await import('fs').then(fs => fs.promises.readFile(filePath));
        
        // Check if it's a gzip file (magic bytes: 1f 8b)
        if (fd.length < 2 || fd[0] !== 0x1f || fd[1] !== 0x8b) {
          throw new Error('Invalid gzip header - file may be corrupted');
        }
        
        console.log(`✓ Tar file validation passed (${Math.round(fd.length / 1024 / 1024)}MB)`);
      } catch (error: any) {
        throw new Error(`Tar file validation failed: ${error.message}`);
      }
    }
    
    // Validate downloaded file before extraction
    await validateTarFile(tempFile);
    
    try {
      // Use Windows native tar.exe on Windows due to npm tar library issues
      if (OS === 'win') {
        console.log('Using Windows native tar.exe for reliable extraction...');
        const relativeTempFile = relative(platformDistPath, tempFile);
        execSync(`tar -xf "${relativeTempFile}"`, { 
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
      
      console.log(`✓ Extraction completed successfully`);
      
    } catch (error: any) {
      // Check if CEF directory was created despite the error (partial extraction)
      const cefDir = join(platformDistPath, 'cef');
      if (existsSync(cefDir)) {
        const cefFiles = readdirSync(cefDir);
        if (cefFiles.length > 0) {
          console.warn(`⚠️ Extraction warning: ${error.message}`);
          console.warn(`  However, CEF files were extracted (${cefFiles.length} files found).`);
          console.warn(`  Proceeding with partial extraction - this usually works fine.`);
          // Don't throw - continue with what we have
        } else {
          // No files extracted, this is a real failure
          throw new Error(`Extraction failed (no files extracted): ${error.message}`);
        }
      } else {
        // No CEF directory created, this is a real failure
        throw new Error(`Extraction failed (no CEF directory created): ${error.message}`);
      }
    }
    
    // Clean up temp file only after successful extraction
    try {
      unlinkSync(tempFile);
    } catch (cleanupError) {
      console.warn('Could not clean up temp file:', cleanupError);
    }
    
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
    
    console.log(`✓ CEF dependencies for ${platformOS}-${platformArch} downloaded and cached successfully`);
    
  } catch (error: any) {
    console.error(`Failed to download CEF dependencies for ${platformOS}-${platformArch}:`, error.message);
    
    // Provide helpful guidance based on the error
    if (error.message.includes('corrupted download') || error.message.includes('zlib') || error.message.includes('unexpected end')) {
      console.error('\n💡 This appears to be a download corruption issue. Suggestions:');
      console.error('  • Check your internet connection stability');
      console.error('  • Try running the command again (it will retry automatically)');
      console.error('  • Clear the cache if the issue persists:');
      console.error(`    rm -rf "${ELECTROBUN_DEP_PATH}"`);
    } else if (error.message.includes('HTTP 404') || error.message.includes('Not Found')) {
      console.error('\n💡 The CEF release was not found. This could mean:');
      console.error('  • The version specified doesn\'t have CEF binaries available');
      console.error('  • You\'re using a development/unreleased version');
      console.error('  • Try using a stable version instead');
    } else {
      console.error('\nPlease ensure you have an internet connection and the release exists.');
      console.error(`If the problem persists, try clearing the cache: rm -rf "${ELECTROBUN_DEP_PATH}"`);
    }
    
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
    useAsar: false,
    asarUnpack: undefined, // Glob patterns for files to exclude from ASAR (e.g., ["*.node", "*.dll"])
    mac: {
      codesign: false,
      notarize: false,
      bundleCEF: false,
      entitlements: {
        // This entitlement is required for Electrobun apps with a hardened runtime (required for notarization) to run on macos
        "com.apple.security.cs.allow-jit": true,
        // Required for bun runtime to work with dynamic code execution and JIT compilation when signed
        "com.apple.security.cs.allow-unsigned-executable-memory": true,
        "com.apple.security.cs.disable-library-validation": true,
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
    preBuild: "",
    postBuild: "",
    postWrap: "",
    postPackage: "",
  },
  release: {
    bucketUrl: "",
  },
};

// Mapping of entitlements to their corresponding Info.plist usage description keys
const ENTITLEMENT_TO_PLIST_KEY: Record<string, string> = {
  "com.apple.security.device.camera": "NSCameraUsageDescription",
  "com.apple.security.device.microphone": "NSMicrophoneUsageDescription",
  "com.apple.security.device.audio-input": "NSMicrophoneUsageDescription",
  "com.apple.security.personal-information.location": "NSLocationUsageDescription",
  "com.apple.security.personal-information.location-when-in-use": "NSLocationWhenInUseUsageDescription",
  "com.apple.security.personal-information.contacts": "NSContactsUsageDescription",
  "com.apple.security.personal-information.calendars": "NSCalendarsUsageDescription",
  "com.apple.security.personal-information.reminders": "NSRemindersUsageDescription",
  "com.apple.security.personal-information.photos-library": "NSPhotoLibraryUsageDescription",
  "com.apple.security.personal-information.apple-music-library": "NSAppleMusicUsageDescription",
  "com.apple.security.personal-information.motion": "NSMotionUsageDescription",
  "com.apple.security.personal-information.speech-recognition": "NSSpeechRecognitionUsageDescription",
  "com.apple.security.device.bluetooth": "NSBluetoothAlwaysUsageDescription",
  "com.apple.security.files.user-selected.read-write": "NSDocumentsFolderUsageDescription",
  "com.apple.security.files.downloads.read-write": "NSDownloadsFolderUsageDescription",
  "com.apple.security.files.desktop.read-write": "NSDesktopFolderUsageDescription",
};

// Helper function to escape XML special characters
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Helper functions
function escapePathForTerminal(path: string): string {
  return `"${path.replace(/"/g, '\\"')}"`;
}

// AppImage tooling functions
async function ensureAppImageTooling(): Promise<void> {
  // First check if FUSE2 is available
  try {
    execSync('ls /usr/lib/*/libfuse.so.2 || ls /lib/*/libfuse.so.2', { stdio: 'ignore' });
  } catch (error) {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('🚨 FUSE2 DEPENDENCY MISSING');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('AppImage creation requires libfuse2, but it was not found on your system.');
    console.log('');
    console.log('Please install it using:');
    console.log('   sudo apt update && sudo apt install -y libfuse2');
    console.log('');
    console.log('Without libfuse2, AppImage creation will fail with FUSE errors.');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    throw new Error('libfuse2 is required for AppImage creation but not found. Please install it first.');
  }

  try {
    // Check if appimagetool is available
    execSync('which appimagetool', { stdio: 'ignore' });
    console.log('✓ appimagetool found');
    return;
  } catch (error) {
    // appimagetool not found, download it automatically
    console.log('📥 appimagetool not found, downloading...');
    
    try {
      // Determine architecture-specific download URL
      const downloadUrl = ARCH === 'arm64' 
        ? 'https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-aarch64.AppImage'
        : 'https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage';
      
      // Download appimagetool
      console.log(`Downloading appimagetool from ${downloadUrl}...`);
      execSync(`wget -q "${downloadUrl}" -O /tmp/appimagetool.AppImage`, { stdio: 'inherit' });
      
      // Make it executable
      execSync('chmod +x /tmp/appimagetool.AppImage', { stdio: 'inherit' });
      
      // Try to move to /usr/local/bin (with sudo)
      try {
        execSync('sudo mv /tmp/appimagetool.AppImage /usr/local/bin/appimagetool', { stdio: 'inherit' });
        console.log('✓ appimagetool installed to /usr/local/bin/appimagetool');
      } catch (sudoError) {
        // Fallback: extract and place in user's local bin
        console.log('sudo not available, installing to ~/.local/bin/...');
        execSync('mkdir -p ~/.local/bin', { stdio: 'inherit' });
        
        // Extract the AppImage to get the binary
        execSync('cd /tmp && ./appimagetool.AppImage --appimage-extract >/dev/null 2>&1', { stdio: 'inherit' });
        execSync('cp /tmp/squashfs-root/usr/bin/appimagetool ~/.local/bin/appimagetool', { stdio: 'inherit' });
        execSync('chmod +x ~/.local/bin/appimagetool', { stdio: 'inherit' });
        
        // Set up symlink for mksquashfs dependency
        execSync('mkdir -p ~/.local/lib/appimagekit', { stdio: 'inherit' });
        execSync('ln -sf /usr/bin/mksquashfs ~/.local/lib/appimagekit/mksquashfs', { stdio: 'inherit' });
        
        // Clean up
        execSync('rm -rf /tmp/appimagetool.AppImage /tmp/squashfs-root', { stdio: 'inherit' });
        
        console.log('✓ appimagetool installed to ~/.local/bin/appimagetool');
        console.log('Note: Make sure ~/.local/bin is in your PATH for future use');
      }
      
    } catch (downloadError) {
      console.error('Failed to download appimagetool:', downloadError);
      throw new Error('Failed to install appimagetool automatically. Please install it manually.');
    }
  }
}

async function createAppImage(
  appBundlePath: string,
  appFileName: string,
  config: any,
  buildFolder: string
): Promise<string> {
  console.log(`🚀 CREATING APPIMAGE WITH PATH: ${appBundlePath}`);
  console.log(`DEBUG: createAppImage called with:`);
  console.log(`  appBundlePath: ${appBundlePath}`);
  console.log(`  appFileName: ${appFileName}`);
  console.log(`  buildFolder: ${buildFolder}`);
  console.log(`  current working directory: ${process.cwd()}`);
  
  // Ensure appBundlePath is absolute - fix for when it's passed as basename only
  let resolvedAppBundlePath = appBundlePath;
  if (!path.isAbsolute(appBundlePath)) {
    resolvedAppBundlePath = join(buildFolder, appBundlePath);
    console.log(`DEBUG: Converted relative path to absolute: ${resolvedAppBundlePath}`);
  }
  
  // Create AppDir structure
  const appDirPath = join(buildFolder, `${appFileName}.AppDir`);
  if (existsSync(appDirPath)) {
    rmSync(appDirPath, { recursive: true, force: true });
  }
  mkdirSync(appDirPath, { recursive: true });
  
  // Copy the entire app bundle to AppDir/usr/bin/
  const usrBinPath = join(appDirPath, 'usr', 'bin');
  mkdirSync(usrBinPath, { recursive: true });
  
  console.log(`DEBUG: Attempting to copy from: ${resolvedAppBundlePath}`);
  console.log(`DEBUG: Does source exist? ${existsSync(resolvedAppBundlePath)}`);
  console.log(`DEBUG: To destination: ${join(usrBinPath, basename(resolvedAppBundlePath))}`);
  
  if (!existsSync(resolvedAppBundlePath)) {
    throw new Error(`Source bundle does not exist: ${resolvedAppBundlePath}`);
  }
  
  console.log(`DEBUG: About to copy with cpSync:`);
  console.log(`  from: ${resolvedAppBundlePath} (exists: ${existsSync(resolvedAppBundlePath)})`);
  console.log(`  to: ${join(usrBinPath, basename(resolvedAppBundlePath))}`);
  
  cpSync(resolvedAppBundlePath, join(usrBinPath, basename(resolvedAppBundlePath)), {
    recursive: true,
    dereference: true
  });
  
  // Create AppRun script (the entry point)
  const appBundleBasename = basename(resolvedAppBundlePath);
  const appRunContent = `#!/bin/bash
# AppRun script for ${appFileName}
HERE="$(dirname "$(readlink -f "\${0}")")"
EXEC="\${HERE}/usr/bin/${appBundleBasename}/bin/launcher"

# Set up library path for CEF
export LD_LIBRARY_PATH="\${HERE}/usr/bin/${appBundleBasename}/bin:\${HERE}/usr/bin/${appBundleBasename}/lib:\${LD_LIBRARY_PATH}"

# Execute the application
exec "\${EXEC}" "\$@"
`;
  
  const appRunPath = join(appDirPath, 'AppRun');
  writeFileSync(appRunPath, appRunContent);
  execSync(`chmod +x ${escapePathForTerminal(appRunPath)}`);
  
  // Create .desktop file in AppDir root
  const desktopContent = `[Desktop Entry]
Version=1.0
Type=Application
Name=${config.app.name}
Comment=${config.app.description || ''}
Exec=${appFileName}
Icon=${appFileName}
Terminal=false
StartupWMClass=${appFileName}
Categories=Utility;
`;
  
  const desktopPath = join(appDirPath, `${appFileName}.desktop`);
  writeFileSync(desktopPath, desktopContent);
  
  // Copy icon if available
  if (config.build.linux?.icon && existsSync(join(projectRoot, config.build.linux.icon))) {
    const iconSourcePath = join(projectRoot, config.build.linux.icon);
    const iconDestPath = join(appDirPath, `${appFileName}.png`);
    const dirIconPath = join(appDirPath, '.DirIcon');
    
    cpSync(iconSourcePath, iconDestPath, { dereference: true });
    cpSync(iconSourcePath, dirIconPath, { dereference: true });
    
    console.log(`Copied icon for AppImage: ${iconSourcePath} -> ${iconDestPath}`);
    console.log(`Created .DirIcon: ${iconSourcePath} -> ${dirIconPath}`);
  }
  
  // Generate the AppImage using appimagetool
  const appImagePath = join(buildFolder, `${appFileName}.AppImage`);
  if (existsSync(appImagePath)) {
    unlinkSync(appImagePath);
  }
  
  console.log(`DEBUG: AppDir path: ${appDirPath}`);
  console.log(`DEBUG: Does AppDir exist? ${existsSync(appDirPath)}`);
  console.log(`Generating AppImage: ${appImagePath}`);
  const appImageArch = ARCH === 'arm64' ? 'aarch64' : 'x86_64';
  
  // Use full path to appimagetool if not in PATH
  let appimagetoolCmd = 'appimagetool';
  try {
    execSync('which appimagetool', { stdio: 'ignore' });
  } catch {
    // Try ~/.local/bin/appimagetool
    const localBinPath = join(process.env['HOME'] || '', '.local', 'bin', 'appimagetool');
    if (existsSync(localBinPath)) {
      appimagetoolCmd = localBinPath;
    }
  }
  
  try {
    // First try with --no-appstream flag to avoid some FUSE-related issues
    execSync(`ARCH=${appImageArch} ${appimagetoolCmd} --no-appstream ${escapePathForTerminal(appDirPath)} ${escapePathForTerminal(appImagePath)}`, {
      stdio: 'inherit',
      env: { ...process.env, ARCH: appImageArch }
    });
  } catch (error) {
    console.error('Failed to create AppImage:', error);
    console.log('Note: If you see FUSE errors, you may need to install libfuse2:');
    console.log('  sudo apt update && sudo apt install -y libfuse2');
    throw error;
  }
  
  // Verify the AppImage was created
  if (!existsSync(appImagePath)) {
    throw new Error(`AppImage was not created at expected path: ${appImagePath}`);
  }
  
  // Extract and copy icon for desktop shortcut
  const iconExtractPath = join(buildFolder, `${appFileName}.png`);
  if (config.build.linux?.icon && existsSync(join(projectRoot, config.build.linux.icon))) {
    const iconSourcePath = join(projectRoot, config.build.linux.icon);
    cpSync(iconSourcePath, iconExtractPath, { dereference: true });
    console.log(`✓ Icon extracted for desktop shortcut: ${iconExtractPath}`);
  }
  
  // Create desktop shortcut alongside the AppImage
  const desktopShortcutPath = join(buildFolder, `${appFileName}.desktop`);
  const desktopShortcutContent = `[Desktop Entry]
Version=1.0
Type=Application
Name=${config.app.name}
Comment=${config.app.description || ''}
Exec=${appImagePath}
Icon=${iconExtractPath}
Terminal=false
StartupWMClass=${appFileName}
Categories=Utility;
`;
  
  writeFileSync(desktopShortcutPath, desktopShortcutContent);
  execSync(`chmod +x ${escapePathForTerminal(desktopShortcutPath)}`);
  console.log(`✓ Desktop shortcut created: ${desktopShortcutPath}`);
  
  // Clean up AppDir
  rmSync(appDirPath, { recursive: true, force: true });
  
  console.log(`✓ AppImage created: ${appImagePath}`);
  return appImagePath;
}

// Helper function to generate usage description entries for Info.plist
function generateUsageDescriptions(entitlements: Record<string, boolean | string>): string {
  const usageEntries: string[] = [];

  for (const [entitlement, value] of Object.entries(entitlements)) {
    const plistKey = ENTITLEMENT_TO_PLIST_KEY[entitlement];
    if (plistKey && value) {
      // Use the string value as description, or a default if it's just true
      const description = typeof value === "string"
        ? escapeXml(value)
        : `This app requires access for ${entitlement.split('.').pop()?.replace('-', ' ')}`;

      usageEntries.push(`    <key>${plistKey}</key>\n    <string>${description}</string>`);
    }
  }

  return usageEntries.join('\n');
}

// Helper function to generate CFBundleURLTypes for custom URL schemes
function generateURLTypes(urlSchemes: string[] | undefined, identifier: string): string {
  if (!urlSchemes || urlSchemes.length === 0) {
    return '';
  }

  const schemesXml = urlSchemes.map(scheme => `                <string>${escapeXml(scheme)}</string>`).join('\n');

  return `    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>${escapeXml(identifier)}</string>
            <key>CFBundleTypeRole</key>
            <string>Viewer</string>
            <key>CFBundleURLSchemes</key>
            <array>
${schemesXml}
            </array>
        </dict>
    </array>`;
}

// Execute command handling
(async () => {
if (commandArg === "init") {
  await (async () => {
    const secondArg = process.argv[indexOfElectrobun + 2];
    const availableTemplates = getTemplateNames();
    
    let projectName: string;
    let templateName: string;
    
    // Check if --template= flag is used
    const templateFlag = process.argv.find(arg => arg.startsWith("--template="));
    if (templateFlag) {
      // Traditional usage: electrobun init my-project --template=photo-booth
      projectName = secondArg || "my-electrobun-app";
      templateName = templateFlag.split("=")[1];
    } else if (secondArg && availableTemplates.includes(secondArg)) {
      // New intuitive usage: electrobun init photo-booth
      projectName = secondArg; // Use template name as project name
      templateName = secondArg;
    } else {
      // Interactive menu when no template specified
      console.log("🚀 Welcome to Electrobun!");
      console.log("");
      console.log("Available templates:");
      availableTemplates.forEach((template, index) => {
        console.log(`  ${index + 1}. ${template}`);
      });
      console.log("");
      
      // Simple CLI selection using readline
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      const choice = await new Promise<string>((resolve) => {
        rl.question('Select a template (enter number): ', (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      });
      
      const templateIndex = parseInt(choice) - 1;
      if (templateIndex < 0 || templateIndex >= availableTemplates.length) {
        console.error(`❌ Invalid selection. Please enter a number between 1 and ${availableTemplates.length}.`);
        process.exit(1);
      }
      
      templateName = availableTemplates[templateIndex];
      
      // Ask for project name
      const rl2 = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      projectName = await new Promise<string>((resolve) => {
        rl2.question(`Enter project name (default: my-${templateName}-app): `, (answer) => {
          rl2.close();
          resolve(answer.trim() || `my-${templateName}-app`);
        });
      });
    }
    
    console.log(`🚀 Initializing Electrobun project: ${projectName}`);
    console.log(`📋 Using template: ${templateName}`);
    
    // Validate template name
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
    console.log("   bun start");
    console.log("");
    console.log("🎉 Happy building with Electrobun!");
  })();
} else if (commandArg === "build") {
  // Get config
  const config = await getConfig();
  
  // Get environment
  const envArg = process.argv.find((arg) => arg.startsWith("--env="))?.split("=")[1] || "";
  const buildEnvironment = ["dev", "canary", "stable"].includes(envArg) ? envArg : "dev";
  
  // Determine current platform as default target
  const currentTarget = { os: OS, arch: ARCH };
  
  // Set up build variables
  const targetOS = currentTarget.os;
  const targetARCH = currentTarget.arch;
  const targetBinExt = targetOS === 'win' ? '.exe' : '';
  const appFileName = `${config.app.name.replace(/ /g, "")}-${buildEnvironment}`;
  const buildSubFolder = `${buildEnvironment}-${currentTarget.os}-${currentTarget.arch}`;
  const buildFolder = join(projectRoot, config.build.buildFolder, buildSubFolder);
  const bundleFileName = targetOS === 'macos' ? `${appFileName}.app` : appFileName;
  const artifactFolder = join(projectRoot, config.build.artifactFolder, buildSubFolder);
  
  // Ensure core binaries are available for the target platform before starting build
  await ensureCoreDependencies(currentTarget.os, currentTarget.arch);
  
  // Get platform-specific paths for the current target
  const targetPaths = getPlatformPaths(currentTarget.os, currentTarget.arch);
  
  // Helper functions
  const sanitizeVolumeNameForHdiutil = (name: string) => {
    return name.replace(/[^a-zA-Z0-9 ]/g, '').trim();
  };

  // Helper to run lifecycle hook scripts
  const runHook = (hookName: keyof typeof config.scripts, extraEnv: Record<string, string> = {}) => {
    const hookScript = config.scripts[hookName];
    if (!hookScript) return;

    console.log(`Running ${hookName} script:`, hookScript);
    // Use host platform's bun binary for running scripts, not target platform's
    const hostPaths = getPlatformPaths(OS, ARCH);

    const result = Bun.spawnSync([hostPaths.BUN_BINARY, hookScript], {
      stdio: ["ignore", "inherit", "inherit"],
      cwd: projectRoot,
      env: {
        ...process.env,
        ELECTROBUN_BUILD_ENV: buildEnvironment,
        ELECTROBUN_OS: targetOS,
        ELECTROBUN_ARCH: targetARCH,
        ELECTROBUN_BUILD_DIR: buildFolder,
        ELECTROBUN_APP_NAME: appFileName,
        ELECTROBUN_APP_VERSION: config.app.version,
        ELECTROBUN_APP_IDENTIFIER: config.app.identifier,
        ELECTROBUN_ARTIFACT_DIR: artifactFolder,
        ...extraEnv,
      },
    });

    if (result.exitCode !== 0) {
      console.error(`${hookName} script failed with exit code:`, result.exitCode);
      if (result.stderr) {
        console.error("stderr:", result.stderr.toString());
      }
      console.error("Tried to run with bun at:", hostPaths.BUN_BINARY);
      console.error("Script path:", hookScript);
      console.error("Working directory:", projectRoot);
      process.exit(1);
    }
  };

  const buildIcons = (appBundleFolderResourcesPath: string) => {
    // Platform-specific icon handling
    if (targetOS === 'macos' && config.build.mac?.icon) {
      const iconPath = join(projectRoot, config.build.mac.icon);
      if (existsSync(iconPath)) {
        const targetIconPath = join(appBundleFolderResourcesPath, "AppIcon.icns");
        cpSync(iconPath, targetIconPath, { dereference: true });
      }
    } else if (targetOS === 'linux' && config.build.linux?.icon) {
      const iconSourcePath = join(projectRoot, config.build.linux.icon);
      if (existsSync(iconSourcePath)) {
        const standardIconPath = join(appBundleFolderResourcesPath, 'appIcon.png');
        
        // Ensure Resources directory exists
        mkdirSync(appBundleFolderResourcesPath, { recursive: true });
        
        // Copy the icon to standard location
        cpSync(iconSourcePath, standardIconPath, { dereference: true });
        console.log(`Copied Linux icon from ${iconSourcePath} to ${standardIconPath}`);
        
        // Also copy icon for the extractor (expects it in Resources/app/icon.png before ASAR packaging)
        const extractorIconPath = join(appBundleFolderResourcesPath, 'app', 'icon.png');
        mkdirSync(join(appBundleFolderResourcesPath, 'app'), { recursive: true });
        cpSync(iconSourcePath, extractorIconPath, { dereference: true });
        console.log(`Copied Linux icon for extractor from ${iconSourcePath} to ${extractorIconPath}`);
      } else {
        console.log(`WARNING: Linux icon not found: ${iconSourcePath}`);
      }
    } else if (targetOS === 'win' && config.build.win?.icon) {
      const iconPath = join(projectRoot, config.build.win.icon);
      if (existsSync(iconPath)) {
        const targetIconPath = join(appBundleFolderResourcesPath, "app.ico");
        cpSync(iconPath, targetIconPath, { dereference: true });
      }
    }
  };

  // Run preBuild hook before anything starts
  runHook('preBuild');

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
  // Generate usage descriptions from entitlements
  const usageDescriptions = generateUsageDescriptions(config.build.mac.entitlements || {});
  // Generate URL scheme handlers
  const urlTypes = generateURLTypes(config.app.urlSchemes, config.app.identifier);

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
    <string>AppIcon</string>${usageDescriptions ? '\n' + usageDescriptions : ''}${urlTypes ? '\n' + urlTypes : ''}
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
  // Copy zig launcher for all platforms
  const bunCliLauncherBinarySource = targetPaths.LAUNCHER_RELEASE;
  const bunCliLauncherDestination = join(appBundleMacOSPath, "launcher") + targetBinExt;
  const destLauncherFolder = dirname(bunCliLauncherDestination);
  if (!existsSync(destLauncherFolder)) {
    mkdirSync(destLauncherFolder, { recursive: true });
  }

  cpSync(bunCliLauncherBinarySource, bunCliLauncherDestination, {
    recursive: true,
    dereference: true,
  });

  cpSync(targetPaths.MAIN_JS, join(appBundleFolderResourcesPath, 'main.js'), { dereference: true });

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
  cpSync(webview2LibSource, webview2LibDestination, { dereference: true });
  
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
  
  // Copy icon if specified for Linux to a standard location
  if (config.build.linux?.icon) {
    const iconSourcePath = join(projectRoot, config.build.linux.icon);
    if (existsSync(iconSourcePath)) {
      const standardIconPath = join(appBundleFolderResourcesPath, 'appIcon.png');
      
      // Ensure Resources directory exists
      mkdirSync(appBundleFolderResourcesPath, { recursive: true });
      
      // Copy the icon to standard location
      cpSync(iconSourcePath, standardIconPath, { dereference: true });
      console.log(`Copied Linux icon from ${iconSourcePath} to ${standardIconPath}`);
      
      // Also copy icon for the extractor (expects it in Resources/app/icon.png before ASAR packaging)
      const extractorIconPath = join(appBundleFolderResourcesPath, 'app', 'icon.png');
      mkdirSync(join(appBundleFolderResourcesPath, 'app'), { recursive: true });
      cpSync(iconSourcePath, extractorIconPath, { dereference: true });
      console.log(`Copied Linux icon for extractor from ${iconSourcePath} to ${extractorIconPath}`);
    } else {
      console.log(`WARNING: Linux icon not found: ${iconSourcePath}`);
    }
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
          cpSync(sourcePath, destPath, { dereference: true });
        }
      });
      
      // Copy icudtl.dat to MacOS root (same folder as libcef.dll) - required for CEF initialization
      const icuDataSource = join(cefSourcePath, 'icudtl.dat');
      const icuDataDest = join(appBundleMacOSPath, 'icudtl.dat');
      if (existsSync(icuDataSource)) {
        cpSync(icuDataSource, icuDataDest, { dereference: true });
      }
      
      // Copy essential CEF pak files to MacOS root (same folder as libcef.dll) - required for CEF resources
      const essentialPakFiles = ['chrome_100_percent.pak', 'resources.pak', 'v8_context_snapshot.bin'];
      essentialPakFiles.forEach(pakFile => {
        const sourcePath = join(cefSourcePath, pakFile);
        const destPath = join(appBundleMacOSPath, pakFile);

        if (existsSync(sourcePath)) {
          cpSync(sourcePath, destPath, { dereference: true });
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
          cpSync(helperSourcePath, destinationPath, { dereference: true });
          
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
          cpSync(icuDataSource, icuDataDest, { dereference: true });
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
            cpSync(sourcePath, destPath, { recursive: true, dereference: true });
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
            cpSync(sourcePath, destPath, { dereference: true });
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
            cpSync(sourcePath, destPath, { dereference: true });
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
              cpSync(cefFilePath, mainDirPath, { dereference: true });
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
            cpSync(helperSourcePath, destinationPath, { dereference: true });
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

  // Copy libasar dynamic library for ASAR support
  const libExt = targetOS === 'win' ? '.dll' : targetOS === 'macos' ? '.dylib' : '.so';

  if (process.platform === 'win32') {
    // On Windows, copy BOTH x64 and ARM64 DLLs so launcher can choose at runtime
    // (x64 Bun on ARM64 Windows can't detect real CPU architecture)
    const x64DistPath = join(ELECTROBUN_DEP_PATH, 'dist-win-x64', 'zig-asar', 'x64', 'libasar.dll');
    const x64VendorPath = join(ELECTROBUN_DEP_PATH, 'vendors', 'zig-asar', 'x64', 'libasar.dll');
    const arm64DistPath = join(ELECTROBUN_DEP_PATH, 'dist-win-x64', 'zig-asar', 'arm64', 'libasar.dll');
    const arm64VendorPath = join(ELECTROBUN_DEP_PATH, 'vendors', 'zig-asar', 'arm64', 'libasar.dll');

    // Copy x64 version as default libasar.dll
    const x64Source = existsSync(x64DistPath) ? x64DistPath : x64VendorPath;
    if (existsSync(x64Source)) {
      cpSync(x64Source, join(appBundleMacOSPath, 'libasar.dll'), {
        recursive: true,
        dereference: true,
      });
    }

    // Copy ARM64 version as libasar-arm64.dll
    const arm64Source = existsSync(arm64DistPath) ? arm64DistPath : arm64VendorPath;
    if (existsSync(arm64Source)) {
      cpSync(arm64Source, join(appBundleMacOSPath, 'libasar-arm64.dll'), {
        recursive: true,
        dereference: true,
      });
    }
  } else {
    // macOS/Linux: single architecture
    const asarLibSource = join(dirname(targetPaths.BSPATCH), 'libasar' + libExt);
    if (existsSync(asarLibSource)) {
      const asarLibDestination = join(appBundleMacOSPath, 'libasar' + libExt);
      cpSync(asarLibSource, asarLibDestination, {
        recursive: true,
        dereference: true,
      });
    }
  }

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
  runHook('postBuild');

  // Pack app resources into ASAR archive if enabled
  if (config.build.useAsar) {
    console.log("Packing resources into ASAR archive...");

    const asarPath = join(appBundleFolderResourcesPath, "app.asar");
    const asarUnpackedPath = join(appBundleFolderResourcesPath, "app.asar.unpacked");

    // Get zig-asar CLI path - on Windows, try x64 first (most common), fall back to arm64
    let zigAsarCli: string;
    if (process.platform === 'win32') {
      // Try x64 first from dist, then vendors
      const x64DistPath = join(ELECTROBUN_DEP_PATH, 'dist-win-x64', 'zig-asar', 'x64', 'zig-asar.exe');
      const x64VendorPath = join(ELECTROBUN_DEP_PATH, 'vendors', 'zig-asar', 'x64', 'zig-asar.exe');
      const arm64DistPath = join(ELECTROBUN_DEP_PATH, 'dist-win-x64', 'zig-asar', 'arm64', 'zig-asar.exe');
      const arm64VendorPath = join(ELECTROBUN_DEP_PATH, 'vendors', 'zig-asar', 'arm64', 'zig-asar.exe');

      zigAsarCli = existsSync(x64DistPath) ? x64DistPath :
                   existsSync(x64VendorPath) ? x64VendorPath :
                   existsSync(arm64DistPath) ? arm64DistPath :
                   arm64VendorPath;

      console.log(`Using zig-asar from: ${zigAsarCli}`);
    } else {
      zigAsarCli = join(targetPaths.BSPATCH).replace('bspatch', 'zig-asar');
    }

    const appDirPath = appBundleAppCodePath;

    // Check if app directory exists
    if (!existsSync(appDirPath)) {
      console.log("⚠ No app directory found, skipping ASAR creation");
    } else {
      // Default unpack patterns for native modules and libraries
      const defaultUnpackPatterns = ["*.node", "*.dll", "*.dylib", "*.so"];
      const unpackPatterns = config.build.asarUnpack || defaultUnpackPatterns;

      // Check if zig-asar CLI exists
      if (!existsSync(zigAsarCli)) {
        console.error(`zig-asar CLI not found at: ${zigAsarCli}`);
        console.error("Make sure to run setup/vendoring first");
        process.exit(1);
      }

      // Build zig-asar command arguments
      // Pack the entire app directory
      const asarArgs = [
        "pack",
        appDirPath,    // source: entire app directory
        asarPath,      // output asar file
      ];

      // Add unpack patterns if any
      // Each pattern needs its own --unpack flag
      for (const pattern of unpackPatterns) {
        asarArgs.push("--unpack", pattern);
      }

      // Run zig-asar pack
      let asarResult = Bun.spawnSync([zigAsarCli, ...asarArgs], {
        stdio: ["ignore", "inherit", "inherit"],
        cwd: projectRoot,
      });

      // If exit code 29 on Windows (binary can't run), try ARM64 version
      if (asarResult.exitCode === 29 && process.platform === 'win32' && zigAsarCli.includes('x64')) {
        console.log("x64 binary failed (exit code 29), trying ARM64 version...");
        const arm64DistPath = join(ELECTROBUN_DEP_PATH, 'dist-win-x64', 'zig-asar', 'arm64', 'zig-asar.exe');
        const arm64VendorPath = join(ELECTROBUN_DEP_PATH, 'vendors', 'zig-asar', 'arm64', 'zig-asar.exe');
        zigAsarCli = existsSync(arm64DistPath) ? arm64DistPath : arm64VendorPath;

        console.log(`Retrying with: ${zigAsarCli}`);
        asarResult = Bun.spawnSync([zigAsarCli, ...asarArgs], {
          stdio: ["ignore", "inherit", "inherit"],
          cwd: projectRoot,
        });
      }

      if (asarResult.exitCode !== 0) {
        console.error("ASAR packing failed with exit code:", asarResult.exitCode);
        if (asarResult.stderr) {
          console.error("stderr:", asarResult.stderr.toString());
        }
        console.error("Command:", zigAsarCli, ...asarArgs);
        process.exit(1);
      }

      // Verify ASAR was created
      if (!existsSync(asarPath)) {
        console.error("ASAR file was not created:", asarPath);
        process.exit(1);
      }

      console.log("✓ Created app.asar");

      // Remove the entire app folder since it's now packed in ASAR
      rmdirSync(appDirPath, { recursive: true });
      console.log("✓ Removed app/ folder (now in ASAR)");
    }
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

  // build.json inside the app bundle - runtime build configuration
  const platformConfig = targetOS === 'macos' ? config.build?.mac :
                         targetOS === 'win' ? config.build?.win :
                         config.build?.linux;

  const bundlesCEF = platformConfig?.bundleCEF ?? false;

  const buildJsonContent = JSON.stringify({
    defaultRenderer: platformConfig?.defaultRenderer ?? 'native',
    availableRenderers: bundlesCEF ? ['native', 'cef'] : ['native'],
  });

  await Bun.write(
    join(appBundleFolderResourcesPath, "build.json"),
    buildJsonContent
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
  
  const artifactsToUpload = [];

  console.log(`DEBUG: Checking for Linux AppImage creation - targetOS: ${targetOS}, buildEnvironment: ${buildEnvironment}`);
  
  // Linux AppImage creation (for all build environments including dev)
  if (targetOS === 'linux') {
    console.log("DEBUG: Creating Linux AppImage...");
    // Ensure AppImage tooling is available
    await ensureAppImageTooling();
    
    // Create AppImage from the app bundle (for both dev and production builds)
    console.log(`🔍 CALLING createAppImage with appBundleFolderPath: ${appBundleFolderPath}`);
    console.log(`🔍 buildFolder: ${buildFolder}`);
    console.log(`🔍 appFileName: ${appFileName}`);
    const appImagePath = await createAppImage(
      appBundleFolderPath,
      appFileName,
      config,
      buildFolder
    );

    console.log(`✓ Linux AppImage created at: ${appImagePath}`);
    
    // Only create compressed tar for non-dev builds
    if (buildEnvironment !== "dev") {
      // For Linux, create a compressed tar containing:
      // 1. The AppImage
      // 2. Desktop shortcut file
      // 3. Icon file
      // 4. Metadata
      
      const tempDirName = `${appFileName}-installer-contents`;
      const tempDirPath = join(buildFolder, tempDirName);
      
      // Clean up any existing temp directory
      if (existsSync(tempDirPath)) {
        rmSync(tempDirPath, { recursive: true });
      }
      
      // Create temp directory structure
      mkdirSync(tempDirPath, { recursive: true });
      const innerDirPath = join(tempDirPath, appFileName);
      mkdirSync(innerDirPath, { recursive: true });
      
      // Copy AppImage
      const appImageDestPath = join(innerDirPath, `${appFileName}.AppImage`);
      cpSync(appImagePath, appImageDestPath, { dereference: true });
      
      // Copy desktop shortcut and icon (they were created alongside the AppImage)
      const desktopPath = join(buildFolder, `${appFileName}.desktop`);
      const iconPath = join(buildFolder, `${appFileName}.png`);
      
      if (existsSync(desktopPath)) {
        cpSync(desktopPath, join(innerDirPath, `${appFileName}.desktop`));
      }
      
      if (existsSync(iconPath)) {
        cpSync(iconPath, join(innerDirPath, `${appFileName}.png`));
      }
      
      // Create metadata file
      const metadata = {
        identifier: config.app.identifier,
        name: config.app.name,
        version: config.app.version,
        channel: buildEnvironment
      };
      writeFileSync(join(innerDirPath, 'metadata.json'), JSON.stringify(metadata, null, 2));
      
      const appImageTarPath = join(buildFolder, `${appFileName}.tar`);
      console.log(`Creating tar of installer contents: ${appImageTarPath}`);
      
      // Tar the inner directory
      await tar.create(
        {
          file: appImageTarPath,
          cwd: tempDirPath,
          gzip: false, // We'll compress with zstd after
        },
        [appFileName]
      );
      
      // Clean up temp directory
      rmSync(tempDirPath, { recursive: true });
      
      // Compress with Zstandard
      console.log(`Compressing tar with zstd...`);
      const uncompressedTarData = readFileSync(appImageTarPath);
      await ZstdInit().then(async ({ ZstdSimple }) => {
        const data = new Uint8Array(uncompressedTarData);
        const compressionLevel = 22;
        const compressedData = ZstdSimple.compress(data, compressionLevel);
        const compressedPath = `${appImageTarPath}.zst`;
        writeFileSync(compressedPath, compressedData);
        console.log(`✓ Created compressed tar: ${compressedPath} (${(compressedData.length / 1024 / 1024).toFixed(2)} MB)`);
      });
      
      // Remove uncompressed tar
      unlinkSync(appImageTarPath);
      
      // Add AppImage to artifacts for distribution (for direct download)
      artifactsToUpload.push(appImagePath);
    }
  }

  if (buildEnvironment !== "dev")  {
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

    // For Linux, we've already created the tar in the AppImage section above
    // For macOS/Windows, tar the signed and notarized app bundle
    if (targetOS !== 'linux') {
      await tar.c(
        {
          gzip: false,
          file: tarPath,
          cwd: buildFolder,
        },
        [basename(appBundleFolderPath)]
      );
    }

    let compressedTarPath = `${tarPath}.zst`;
    
    // For Linux, skip compression as we already have the compressed tar
    if (targetOS === 'linux') {
      console.log("Linux tar.zst already created, skipping general compression step");
      // compressedTarPath already points to the right file
    } else {
      const tarball = Bun.file(tarPath);
      const tarBuffer = await tarball.arrayBuffer();

      // Note: The playground app bundle is around 48MB.
      // compression on m1 max with 64GB ram:
      //   brotli: 1min 38s, 48MB -> 11.1MB
      //   zstd: 15s, 48MB -> 12.1MB
      // zstd is the clear winner here. dev iteration speed gain of 1min 15s per build is much more valubale
      // than saving 1 more MB of space/bandwidth.

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
    }

    // For macOS/Windows, delete the original app bundle since we've tarred it
    // For Linux, the app bundle was already converted to AppImage, so the directory might not exist
    if (targetOS !== 'linux') {
      rmdirSync(appBundleFolderPath, { recursive: true });
    }

    const selfExtractingBundle = createAppBundle(appFileName, buildFolder, targetOS);
    const compressedTarballInExtractingBundlePath = join(
      selfExtractingBundle.appBundleFolderResourcesPath,
      `${hash}.tar.zst`
    );

    // copy the zstd tarball to the self-extracting app bundle
    cpSync(compressedTarPath, compressedTarballInExtractingBundlePath, { dereference: true });

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

    // Run postWrap hook after self-extracting bundle is created, before code signing
    // This is where you can add files to the wrapper (e.g., for liquid glass support)
    runHook('postWrap', { ELECTROBUN_WRAPPER_BUNDLE_PATH: selfExtractingBundle.appBundleFolderPath });

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
      const finalDmgPath = join(buildFolder, `${appFileName}.dmg`);
      // NOTE: For some ungodly reason using the bare name in CI can conflict with some mysterious
      // already mounted volume. I suspect the sanitized appFileName can match your github repo
      // or some other tool is mounting something somewhere. Either way, as a workaround
      // while creating the dmg for a stable build we temporarily give it a -stable suffix
      // to match the behaviour of -canary builds.
      const dmgCreationPath =
        buildEnvironment === "stable"
          ? join(buildFolder, `${appFileName}-stable.dmg`)
          : finalDmgPath;
      const baseVolumeName = sanitizeVolumeNameForHdiutil(appFileName);
      const dmgVolumeName =
        buildEnvironment === "stable"
          ? `${baseVolumeName}-stable`
          : baseVolumeName;

      // Create a staging directory for DMG contents (app + Applications shortcut)
      const dmgStagingDir = join(buildFolder, '.dmg-staging');
      if (existsSync(dmgStagingDir)) {
        rmSync(dmgStagingDir, { recursive: true });
      }
      mkdirSync(dmgStagingDir, { recursive: true });

      // Copy the app bundle to the staging directory
      const stagedAppPath = join(dmgStagingDir, basename(selfExtractingBundle.appBundleFolderPath));
      execSync(`cp -R ${escapePathForTerminal(selfExtractingBundle.appBundleFolderPath)} ${escapePathForTerminal(stagedAppPath)}`);

      // Create a symlink to /Applications for easy drag-and-drop installation
      const applicationsLink = join(dmgStagingDir, 'Applications');
      symlinkSync('/Applications', applicationsLink);

      // hdiutil create -volname "YourAppName" -srcfolder /path/to/staging -ov -format UDZO YourAppName.dmg
      // Note: use ULFO (lzfse) for better compatibility with large CEF frameworks and modern macOS
      execSync(
        `hdiutil create -volname "${dmgVolumeName}" -srcfolder ${escapePathForTerminal(
          dmgStagingDir
        )} -ov -format ULFO ${escapePathForTerminal(dmgCreationPath)}`
      );

      // Clean up staging directory
      rmSync(dmgStagingDir, { recursive: true });
      if (buildEnvironment === "stable" && dmgCreationPath !== finalDmgPath) {
        renameSync(dmgCreationPath, finalDmgPath);
      }
      artifactsToUpload.push(finalDmgPath);

      if (shouldCodesign) {
        codesignAppBundle(finalDmgPath);
      } else {
        console.log("skipping codesign");
      }

      if (shouldNotarize) {
        notarizeAndStaple(finalDmgPath);
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
        // On Linux, create a self-extracting AppImage with embedded archive
        // Use the Linux-specific compressed tar path
        const linuxCompressedTarPath = join(buildFolder, `${appFileName}.tar.zst`);
        const selfExtractingAppImagePath = await createLinuxSelfExtractingAppImage(
          buildFolder,
          linuxCompressedTarPath,
          appFileName,
          config,
          buildEnvironment,
          hash
        );
        
        artifactsToUpload.push(selfExtractingAppImagePath);
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
          {
            cwd: buildFolder,
            stdout: "inherit",
            stderr: "inherit"
          }
        );
        if (!result.success) {
          throw new Error(`bsdiff failed with exit code ${result.exitCode}`);
        }
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
      cpSync(filePath, join(artifactFolder, filename), { dereference: true });
    });

    // todo: now just upload the artifacts to your bucket replacing the ones that exist
    // you'll end up with a sequence of patch files that will
  }

  // Run postPackage hook at the very end of the build process
  runHook('postPackage');

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

  // Get config for dev mode
  const config = await getConfig();
  
  // Set up dev build variables (similar to build mode)
  const buildEnvironment = "dev";
  const currentTarget = { os: OS, arch: ARCH };
  const appFileName = `${config.app.name.replace(/ /g, "")}-${buildEnvironment}`;
  const buildSubFolder = `${buildEnvironment}-${currentTarget.os}-${currentTarget.arch}`;
  const buildFolder = join(projectRoot, config.build.buildFolder, buildSubFolder);
  const bundleFileName = OS === 'macos' ? `${appFileName}.app` : appFileName;

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
  let isAppImage = false;
  
  if (OS === 'macos') {
    bundleExecPath = join(buildFolder, bundleFileName, "Contents", 'MacOS');
    bundleResourcesPath = join(buildFolder, bundleFileName, "Contents", 'Resources');
  } else if (OS === 'linux') {
    // Check if we have an AppImage or directory bundle
    const appImagePath = join(buildFolder, `${bundleFileName}.AppImage`);
    if (existsSync(appImagePath)) {
      // AppImage mode
      bundleExecPath = appImagePath;
      bundleResourcesPath = join(buildFolder, bundleFileName, "Resources"); // For compatibility
      isAppImage = true;
    } else {
      // Directory bundle mode (fallback)
      bundleExecPath = join(buildFolder, bundleFileName, "bin");
      bundleResourcesPath = join(buildFolder, bundleFileName, "Resources");
    }
  } else if (OS === 'win') {
    bundleExecPath = join(buildFolder, bundleFileName, "bin");
    bundleResourcesPath = join(buildFolder, bundleFileName, "Resources");
  } else {
    throw new Error(`Unsupported OS: ${OS}`);
  }

  if (OS === 'macos' || OS === 'linux') {
    // For Linux dev mode, update libNativeWrapper.so based on bundleCEF setting
    if (OS === 'linux' && !isAppImage) {
      // Only update libNativeWrapper for directory bundle mode
      const currentLibPath = join(bundleExecPath, 'libNativeWrapper.so');
      const targetPaths = getPlatformPaths('linux', ARCH);
      const correctLibSource = config.build.linux?.bundleCEF 
        ? targetPaths.NATIVE_WRAPPER_LINUX_CEF 
        : targetPaths.NATIVE_WRAPPER_LINUX;
      
      if (existsSync(correctLibSource)) {
        try {
          cpSync(correctLibSource, currentLibPath, { dereference: true });
          console.log(`Updated libNativeWrapper.so for ${config.build.linux?.bundleCEF ? 'CEF' : 'GTK-only'} mode`);
        } catch (error) {
          console.warn('Failed to update libNativeWrapper.so:', error);
        }
      }
    }
    
    if (OS === 'linux' && isAppImage) {
      // For Linux AppImage mode, execute the AppImage directly
      console.log(`Running AppImage: ${bundleExecPath}`);
      mainProc = Bun.spawn([bundleExecPath], {
        stdio: ['inherit', 'inherit', 'inherit'],
        cwd: dirname(bundleExecPath)
      });
    } else {
      // Use the zig launcher for macOS and directory bundle Linux
      mainProc = Bun.spawn([join(bundleExecPath, 'launcher')], {
        stdio: ['inherit', 'inherit', 'inherit'],
        cwd: bundleExecPath
      });
    }
  } else if (OS === 'win') {  
    // Windows: Use launcher if available, otherwise fallback to direct execution
    const launcherPath = join(bundleExecPath, 'launcher.exe');
    if (existsSync(launcherPath)) {
      mainProc = Bun.spawn([launcherPath], {
        stdio: ['inherit', 'inherit', 'inherit'],
        cwd: bundleExecPath
      })
    } else {
      // Fallback for older builds
      mainProc = Bun.spawn(['./bun.exe', '../Resources/main.js'], {
        stdio: ['inherit', 'inherit', 'inherit'],
        cwd: bundleExecPath,
        onExit: (proc, exitCode, signalCode, error) => {
          console.log('Bun process exited:', { exitCode, signalCode, error });
        }
      })
    }
  }

  process.on("SIGINT", () => {
    console.log('[electrobun dev] Received SIGINT, initiating graceful shutdown...')
    
    if (mainProc) {
      // First attempt graceful shutdown by sending SIGINT to child
      console.log('[electrobun dev] Requesting graceful shutdown from app...')
      mainProc.kill("SIGINT");
      
      // Give the app time to clean up (e.g., call killApp())
      setTimeout(() => {
        if (mainProc && !mainProc.killed) {
          console.log('[electrobun dev] App did not exit gracefully, forcing termination...')
          mainProc.kill("SIGKILL");
        }
        process.exit(0);
      }, 2000); // 2 second timeout for graceful shutdown
    } else {
      process.exit(0);
    }
  });

}

// Helper functions

async function getConfig() {
  let loadedConfig = {};
  const foundConfigPath = findConfigFile();
  
  if (foundConfigPath) {
    console.log(`Using config file: ${basename(foundConfigPath)}`);
    
    try {
      // Use dynamic import for TypeScript ESM files
      // Bun handles TypeScript natively, no transpilation needed
      const configModule = await import(foundConfigPath);
      loadedConfig = configModule.default || configModule;
      
      // Validate that we got a valid config object
      if (!loadedConfig || typeof loadedConfig !== 'object') {
        console.error("Config file must export a default object");
        console.error("using default config instead");
        loadedConfig = {};
      }
    } catch (error) {
      console.error("Failed to load config file:", error);
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

function buildEntitlementsFile(entitlements: Record<string, boolean | string>) {
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
    // For string values (usage descriptions), still return boolean true for the entitlement
    return `<true/>`;
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

async function createLinuxSelfExtractingAppImage(
  buildFolder: string,
  compressedTarPath: string,
  appFileName: string,
  config: any,
  buildEnvironment: string,
  hash: string
): Promise<string> {
  console.log('Creating Linux AppImage wrapper...');

  // Create wrapper AppImage filename
  const wrapperName = buildEnvironment === 'stable' 
    ? `${config.app.name}-Setup`
    : `${config.app.name}-Setup-${buildEnvironment}`;
  
  const wrapperAppImagePath = join(buildFolder, `${wrapperName}.AppImage`);
  const wrapperAppDirPath = join(buildFolder, `${wrapperName}.AppDir`);

  // Clean up any existing AppDir
  if (existsSync(wrapperAppDirPath)) {
    rmSync(wrapperAppDirPath, { recursive: true, force: true });
  }
  mkdirSync(wrapperAppDirPath, { recursive: true });

  // Create usr/bin directory structure
  const usrBinPath = join(wrapperAppDirPath, 'usr', 'bin');
  mkdirSync(usrBinPath, { recursive: true });

  // Create self-extracting binary with embedded archive (following magic markers pattern)
  const targetPaths = getPlatformPaths('linux', ARCH);
  
  // Read the extractor binary
  const extractorBinary = readFileSync(targetPaths.EXTRACTOR);
  
  // Read the compressed archive
  const compressedArchive = readFileSync(compressedTarPath);
  
  // Create metadata JSON
  const metadata = {
    identifier: config.app.identifier,
    name: config.app.name,
    channel: buildEnvironment,
    hash: hash
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
  
  // Write the self-extracting binary to AppImage/usr/bin/
  const wrapperExtractorPath = join(usrBinPath, wrapperName);
  writeFileSync(wrapperExtractorPath, combinedBuffer, { mode: 0o755 });
  execSync(`chmod +x ${escapePathForTerminal(wrapperExtractorPath)}`);

  // Create AppRun script
  const appRunContent = `#!/bin/bash
# AppRun script for ${wrapperName}
HERE="$(dirname "$(readlink -f "\${0}")")"
EXEC="\${HERE}/usr/bin/${wrapperName}"

# Execute the wrapper extractor
exec "\${EXEC}" "\$@"
`;
  
  const appRunPath = join(wrapperAppDirPath, 'AppRun');
  writeFileSync(appRunPath, appRunContent);
  execSync(`chmod +x ${escapePathForTerminal(appRunPath)}`);

  // Create desktop file
  const desktopContent = `[Desktop Entry]
Version=1.0
Type=Application
Name=${config.app.name} Installer
Comment=Install ${config.app.name}
Exec=${wrapperName}
Icon=${wrapperName}
Terminal=false
Categories=Utility;
`;
  
  const desktopPath = join(wrapperAppDirPath, `${wrapperName}.desktop`);
  writeFileSync(desktopPath, desktopContent);

  // Copy icon if available
  if (config.build.linux?.icon && existsSync(join(projectRoot, config.build.linux.icon))) {
    const iconSourcePath = join(projectRoot, config.build.linux.icon);
    const iconDestPath = join(wrapperAppDirPath, `${wrapperName}.png`);
    const dirIconPath = join(wrapperAppDirPath, '.DirIcon');
    
    cpSync(iconSourcePath, iconDestPath, { dereference: true });
    cpSync(iconSourcePath, dirIconPath, { dereference: true });
    
    console.log(`Copied icon for wrapper AppImage: ${iconSourcePath} -> ${iconDestPath}`);
  }

  // Ensure appimagetool is available
  await ensureAppImageTooling();

  // Generate the wrapper AppImage
  if (existsSync(wrapperAppImagePath)) {
    unlinkSync(wrapperAppImagePath);
  }

  console.log(`Creating wrapper AppImage: ${wrapperAppImagePath}`);
  const appImageArch = ARCH === 'arm64' ? 'aarch64' : 'x86_64';
  
  // Use appimagetool to create the wrapper AppImage
  let appimagetoolCmd = 'appimagetool';
  try {
    execSync('which appimagetool', { stdio: 'ignore' });
  } catch {
    const localBinPath = join(process.env['HOME'] || '', '.local', 'bin', 'appimagetool');
    if (existsSync(localBinPath)) {
      appimagetoolCmd = localBinPath;
    }
  }

  try {
    execSync(`ARCH=${appImageArch} ${appimagetoolCmd} --no-appstream ${escapePathForTerminal(wrapperAppDirPath)} ${escapePathForTerminal(wrapperAppImagePath)}`, {
      stdio: 'inherit',
      env: { ...process.env, ARCH: appImageArch }
    });
  } catch (error) {
    console.error('Failed to create wrapper AppImage:', error);
    throw error;
  }

  // Clean up AppDir
  rmSync(wrapperAppDirPath, { recursive: true, force: true });

  // Verify the wrapper AppImage was created
  if (!existsSync(wrapperAppImagePath)) {
    throw new Error(`Wrapper AppImage was not created at expected path: ${wrapperAppImagePath}`);
  }

  const stats = statSync(wrapperAppImagePath);
  console.log(`✓ Linux wrapper AppImage created: ${wrapperAppImagePath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
  
  return wrapperAppImagePath;
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

  // Sign frameworks first (CEF framework requires special handling)
  const frameworksPath = join(contentsPath, 'Frameworks');
  if (existsSync(frameworksPath)) {
    try {
      const frameworks = readdirSync(frameworksPath);
      for (const framework of frameworks) {
        if (framework.endsWith('.framework')) {
          const frameworkPath = join(frameworksPath, framework);
          
          if (framework === 'Chromium Embedded Framework.framework') {
            console.log(`Signing CEF framework components: ${framework}`);
            
            // Sign CEF libraries first
            const librariesPath = join(frameworkPath, 'Libraries');
            if (existsSync(librariesPath)) {
              const libraries = readdirSync(librariesPath);
              for (const library of libraries) {
                if (library.endsWith('.dylib')) {
                  const libraryPath = join(librariesPath, library);
                  console.log(`Signing CEF library: ${library}`);
                  execSync(
                    `codesign --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" --options runtime ${escapePathForTerminal(libraryPath)}`
                  );
                }
              }
            }
            
            // CEF helper apps are in the main Frameworks directory, not inside the CEF framework
            // We'll sign them after signing all frameworks
          }
          
          // Sign the framework bundle itself (for CEF and any other frameworks)
          console.log(`Signing framework bundle: ${framework}`);
          execSync(
            `codesign --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" --options runtime ${escapePathForTerminal(frameworkPath)}`
          );
        }
      }
    } catch (err) {
      console.log("Error signing frameworks:", err);
      throw err; // Re-throw to fail the build since framework signing is critical
    }
  }
  
  // Sign CEF helper apps (they're in the main Frameworks directory, not inside CEF framework)
  const cefHelperApps = [
    'bun Helper.app',
    'bun Helper (GPU).app', 
    'bun Helper (Plugin).app',
    'bun Helper (Alerts).app',
    'bun Helper (Renderer).app'
  ];
  
  for (const helperApp of cefHelperApps) {
    const helperPath = join(frameworksPath, helperApp);
    if (existsSync(helperPath)) {
      const helperExecutablePath = join(helperPath, 'Contents', 'MacOS', helperApp.replace('.app', ''));
      if (existsSync(helperExecutablePath)) {
        console.log(`Signing CEF helper executable: ${helperApp}`);
        const entitlementFlag = entitlementsFilePath ? `--entitlements ${entitlementsFilePath}` : '';
        execSync(
          `codesign --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" --options runtime ${entitlementFlag} ${escapePathForTerminal(helperExecutablePath)}`
        );
      }
      
      console.log(`Signing CEF helper bundle: ${helperApp}`);
      const entitlementFlag = entitlementsFilePath ? `--entitlements ${entitlementsFilePath}` : '';
      execSync(
        `codesign --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" --options runtime ${entitlementFlag} ${escapePathForTerminal(helperPath)}`
      );
    }
  }

  // Sign all binaries and libraries in MacOS folder and subdirectories
  console.log("Signing all binaries in MacOS folder...");
  
  // Recursively find all executables and libraries in MacOS folder
  function findExecutables(dir: string): string[] {
    let executables: string[] = [];
    
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        
        if (entry.isDirectory()) {
          // Recursively search subdirectories
          executables = executables.concat(findExecutables(fullPath));
        } else if (entry.isFile()) {
          // Check if it's an executable or library
          try {
            const fileInfo = execSync(`file -b "${fullPath}"`, { encoding: 'utf8' }).trim();
            if (fileInfo.includes('Mach-O') || entry.name.endsWith('.dylib')) {
              executables.push(fullPath);
            }
          } catch {
            // If file command fails, check by extension
            if (entry.name.endsWith('.dylib') || !entry.name.includes('.')) {
              // No extension often means executable
              executables.push(fullPath);
            }
          }
        }
      }
    } catch (err) {
      console.error(`Error scanning directory ${dir}:`, err);
    }
    
    return executables;
  }
  
  const executablesInMacOS = findExecutables(macosPath);
  
  // Sign each found executable
  for (const execPath of executablesInMacOS) {
    const fileName = basename(execPath);
    const relativePath = execPath.replace(macosPath + '/', '');
    
    // Use filename as identifier (without extension)
    const identifier = fileName.replace(/\.[^.]+$/, '');
    
    console.log(`Signing ${relativePath} with identifier ${identifier}`);
    const entitlementFlag = entitlementsFilePath ? `--entitlements ${entitlementsFilePath}` : '';
    
    try {
      execSync(
        `codesign --force --verbose --timestamp --sign "${ELECTROBUN_DEVELOPER_ID}" --options runtime --identifier ${identifier} ${entitlementFlag} ${escapePathForTerminal(execPath)}`
      );
    } catch (err) {
      console.error(`Failed to sign ${relativePath}:`, err.message);
      // Continue signing other files even if one fails
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

// Close the command handling if/else chain

// Close and execute the async IIFE
})().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

