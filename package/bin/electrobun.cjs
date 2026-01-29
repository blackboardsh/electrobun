#!/usr/bin/env bun

// Electrobun requires Bun 1.3.6+ for Bun.Archive support
const MIN_BUN_VERSION = '1.3.6';
if (typeof Bun !== 'undefined') {
  const current = Bun.version;
  const [curMaj, curMin, curPatch] = current.split('.').map(Number);
  const [minMaj, minMin, minPatch] = MIN_BUN_VERSION.split('.').map(Number);
  if (curMaj < minMaj || (curMaj === minMaj && (curMin < minMin || (curMin === minMin && curPatch < minPatch)))) {
    console.error(`Electrobun requires Bun >= ${MIN_BUN_VERSION}, but you are running Bun ${current}.`);
    console.error(`Please upgrade: bun upgrade`);
    process.exit(1);
  }
} else {
  console.error('Electrobun requires the Bun runtime. Install it: https://bun.sh');
  process.exit(1);
}

const { existsSync, mkdirSync, unlinkSync, chmodSync, copyFileSync } = require('fs');
const { join, dirname } = require('path');
const { spawn } = require('child_process');

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
// Always use x64 for Windows since we only build x64 Windows binaries
const arch = platform === 'win' ? 'x64' : getArch();
const binExt = platform === 'win' ? '.exe' : '';

// Paths
const electrobunDir = join(__dirname, '..');
const cacheDir = join(electrobunDir, '.cache');
const cliBinary = join(cacheDir, `electrobun${binExt}`);

async function ensureCliBinary() {
  // Check if CLI binary exists in bin location (where npm expects it)
  const binLocation = join(electrobunDir, 'bin', 'electrobun' + binExt);
  if (existsSync(binLocation)) {
    return binLocation;
  }

  // Check if core dependencies already exist in cache
  if (existsSync(cliBinary)) {
    // Copy to bin location if it exists in cache but not in bin
    mkdirSync(dirname(binLocation), { recursive: true });
    copyFileSync(cliBinary, binLocation);
    if (platform !== 'win') {
      chmodSync(binLocation, '755');
    }
    return binLocation;
  }

  console.log('Downloading electrobun CLI for your platform...');

  // Get the package version to download the matching release
  const packageJson = require(join(electrobunDir, 'package.json'));
  const version = packageJson.version;
  const tag = `v${version}`;

  const tarballUrl = `https://github.com/blackboardsh/electrobun/releases/download/${tag}/electrobun-cli-${platform}-${arch}.tar.gz`;
  const tarballPath = join(cacheDir, `electrobun-${platform}-${arch}.tar.gz`);

  try {
    // Download tarball using fetch (available in Bun)
    mkdirSync(cacheDir, { recursive: true });
    const response = await fetch(tarballUrl, { redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }
    await Bun.write(tarballPath, response);

    // Extract CLI binary using Bun.Archive
    const tarBytes = await Bun.file(tarballPath).arrayBuffer();
    const archive = new Bun.Archive(tarBytes);
    await archive.extract(cacheDir);

    // Clean up tarball
    unlinkSync(tarballPath);

    // Check if CLI binary was extracted
    if (!existsSync(cliBinary)) {
      throw new Error(`CLI binary not found at ${cliBinary} after extraction`);
    }

    // Make executable on Unix systems
    if (platform !== 'win') {
      chmodSync(cliBinary, '755');
    }

    // Copy CLI to bin location so npm scripts can find it
    mkdirSync(dirname(binLocation), { recursive: true });
    copyFileSync(cliBinary, binLocation);

    // Make the bin location executable too
    if (platform !== 'win') {
      chmodSync(binLocation, '755');
    }

    console.log('electrobun CLI downloaded successfully!');
    return binLocation;

  } catch (error) {
    throw new Error(`Failed to download electrobun CLI: ${error.message}`);
  }
}

async function main() {
  try {
    const args = process.argv.slice(2);
    const cliPath = await ensureCliBinary();

    // Replace this process with the actual CLI
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
