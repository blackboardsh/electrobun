#!/usr/bin/env bun

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import tar from 'tar';
import { fileURLToPath } from 'url';
import process from 'process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const platform = process.platform;
const arch = process.arch;

// Map Node.js platform/arch to our naming
const platformMap = {
  'darwin': 'darwin',
  'linux': 'linux',
  'win32': 'win32'
};

const archMap = {
  'x64': 'x64',
  'arm64': 'arm64'
};

const platformName = platformMap[platform] || platform;
const archName = archMap[arch] || arch;

console.log(`Packaging Electrobun for ${platformName}-${archName}...`);

// Build everything including CLI (no CI mode needed)
console.log('Building full release...');
execSync('bun build.ts --release', { stdio: 'inherit' });

// Build CLI binary
console.log('Building CLI binary...');
execSync('mkdir -p bin && bun build src/cli/index.ts --compile --outfile bin/electrobun', { stdio: 'inherit' });

// Create separate tarballs for CLI, core binaries, and CEF
const distPath = path.join(__dirname, '..', 'dist');
const cliOutputFile = path.join(__dirname, '..', `electrobun-cli-${platformName}-${archName}.tar.gz`);
const coreOutputFile = path.join(__dirname, '..', `electrobun-core-${platformName}-${archName}.tar.gz`);
const cefOutputFile = path.join(__dirname, '..', `electrobun-cef-${platformName}-${archName}.tar.gz`);

console.log(`Creating CLI tarball: ${cliOutputFile}`);

// Check if dist exists
if (!fs.existsSync(distPath)) {
  console.error('Error: dist directory not found');
  process.exit(1);
}

async function createTarballs() {
  // 1. Create CLI-only tarball
  const binPath = path.join(__dirname, '..', 'bin');
  const cliSrc = path.join(binPath, 'electrobun' + (platform === 'win32' ? '.exe' : ''));
  
  if (fs.existsSync(cliSrc)) {
    console.log(`Creating CLI tarball: ${cliOutputFile}`);
    
    // Create CLI tarball directly from bin directory
    await tar.c({
      gzip: true,
      file: cliOutputFile,
      cwd: binPath,
      portable: true
    }, ['electrobun' + (platform === 'win32' ? '.exe' : '')]);
    
    const cliStats = fs.statSync(cliOutputFile);
    const cliSizeMB = (cliStats.size / 1024 / 1024).toFixed(2);
    console.log(`CLI tarball size: ${cliSizeMB} MB`);
  }

  // 2. Create core binaries tarball (exclude CEF)
  const coreFiles = fs.readdirSync(distPath).filter(file => file !== 'cef');
  
  if (coreFiles.length > 0) {
    console.log(`Creating core binaries tarball: ${coreOutputFile}`);
    
    await tar.c({
      gzip: true,
      file: coreOutputFile,
      cwd: distPath,
      portable: true
    }, coreFiles);
    
    const coreStats = fs.statSync(coreOutputFile);
    const coreSizeMB = (coreStats.size / 1024 / 1024).toFixed(2);
    console.log(`Core binaries tarball size: ${coreSizeMB} MB`);
  }

  // 3. Create CEF tarball if CEF directory exists
  const cefPath = path.join(distPath, 'cef');
  if (fs.existsSync(cefPath)) {
    console.log(`Creating CEF tarball: ${cefOutputFile}`);
    
    await tar.c({
      gzip: true,
      file: cefOutputFile,
      cwd: distPath,
      portable: true
    }, ['cef']);
    
    const cefStats = fs.statSync(cefOutputFile);
    const cefSizeMB = (cefStats.size / 1024 / 1024).toFixed(2);
    console.log(`CEF tarball size: ${cefSizeMB} MB`);
  } else {
    console.log('No CEF directory found, skipping CEF tarball');
  }
}

createTarballs().catch(err => {
  console.error('Error creating tarballs:', err);
  process.exit(1);
});