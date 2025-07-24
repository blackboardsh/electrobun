#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const { existsSync, mkdirSync, createWriteStream, unlinkSync, chmodSync } = require('fs');
const { join, dirname } = require('path');
const https = require('https');
const tar = require('tar');

// Detect platform and architecture
function getPlatform() {
  switch (process.platform) {
    case 'win32': return 'win';
    case 'darwin': return 'darwin';
    case 'linux': return 'linux';
    default: throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

function getArch() {
  switch (process.arch) {
    case 'arm64': return 'arm64';
    case 'x64': return 'x64';
    default: throw new Error(`Unsupported architecture: ${process.arch}`);
  }
}

const platform = getPlatform();
const arch = getArch();
const binExt = platform === 'win' ? '.exe' : '';

// Paths
const electrobunDir = join(__dirname, '..');
const cacheDir = join(electrobunDir, '.cache');
const cliBinary = join(cacheDir, `electrobun${binExt}`);

async function downloadFile(url, filePath) {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(filePath), { recursive: true });
    const file = createWriteStream(filePath);
    
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        return downloadFile(response.headers.location, filePath).then(resolve).catch(reject);
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: ${response.statusCode}`));
        return;
      }
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        resolve();
      });
      
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureCliBinary() {
  if (existsSync(cliBinary)) {
    return cliBinary;
  }

  console.log('Downloading electrobun CLI for your platform...');
  
  // Get the package version to download the matching release
  const packageJson = require(join(electrobunDir, 'package.json'));
  const version = packageJson.version;
  const tag = `v${version}`;
  
  const tarballUrl = `https://github.com/blackboardsh/electrobun/releases/download/${tag}/electrobun-${platform}-${arch}.tar.gz`;
  const tarballPath = join(cacheDir, `electrobun-${platform}-${arch}.tar.gz`);
  
  try {
    // Download tarball
    await downloadFile(tarballUrl, tarballPath);
    
    // Extract CLI binary
    await tar.x({
      file: tarballPath,
      cwd: cacheDir,
      strip: 1 // Remove the top-level directory
    });
    
    // Clean up tarball
    unlinkSync(tarballPath);
    
    // Make executable on Unix systems
    if (platform !== 'win') {
      chmodSync(cliBinary, '755');
    }
    
    console.log('electrobun CLI downloaded successfully!');
    return cliBinary;
    
  } catch (error) {
    throw new Error(`Failed to download electrobun CLI: ${error.message}`);
  }
}

async function main() {
  try {
    const cliPath = await ensureCliBinary();
    
    // Replace this process with the actual CLI
    const args = process.argv.slice(2);
    const child = spawn(cliPath, args, {
      stdio: 'inherit',
      cwd: process.cwd()
    });
    
    child.on('exit', (code) => {
      process.exit(code || 0);
    });
    
    child.on('error', (error) => {
      console.error('Failed to start electrobun CLI:', error.message);
      process.exit(1);
    });
    
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();