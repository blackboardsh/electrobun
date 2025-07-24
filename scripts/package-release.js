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

// Create the main tarball (without CEF)
const distPath = path.join(__dirname, '..', 'dist');
const mainOutputFile = path.join(__dirname, '..', `electrobun-${platformName}-${archName}.tar.gz`);
const cefOutputFile = path.join(__dirname, '..', `electrobun-cef-${platformName}-${archName}.tar.gz`);

console.log(`Creating main tarball: ${mainOutputFile}`);

// Check if dist exists
if (!fs.existsSync(distPath)) {
  console.error('Error: dist directory not found');
  process.exit(1);
}

// Create list of files to include in main tarball (exclude CEF but include CLI)
const mainFiles = fs.readdirSync(distPath).filter(file => file !== 'cef');

// Add CLI binary to files list
const binPath = path.join(__dirname, '..', 'bin');
if (fs.existsSync(binPath)) {
  // Copy CLI binary to dist for packaging
  const cliSrc = path.join(binPath, 'electrobun' + (platform === 'win32' ? '.exe' : ''));
  const cliDest = path.join(distPath, 'electrobun' + (platform === 'win32' ? '.exe' : ''));
  if (fs.existsSync(cliSrc)) {
    fs.copyFileSync(cliSrc, cliDest);
    mainFiles.push('electrobun' + (platform === 'win32' ? '.exe' : ''));
  }
}

// Create main tarball
tar.c({
  gzip: true,
  file: mainOutputFile,
  cwd: distPath,
  portable: true
}, mainFiles)
  .then(() => {
    console.log(`Successfully created ${mainOutputFile}`);
    
    // Print file size
    const stats = fs.statSync(mainOutputFile);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`Main tarball size: ${sizeMB} MB`);
    
    // Create CEF tarball if CEF directory exists
    const cefPath = path.join(distPath, 'cef');
    if (fs.existsSync(cefPath)) {
      console.log(`Creating CEF tarball: ${cefOutputFile}`);
      
      return tar.c({
        gzip: true,
        file: cefOutputFile,
        cwd: distPath,
        portable: true
      }, ['cef']);
    } else {
      console.log('No CEF directory found, skipping CEF tarball');
      return Promise.resolve();
    }
  })
  .then(() => {
    if (fs.existsSync(cefOutputFile)) {
      const stats = fs.statSync(cefOutputFile);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      console.log(`CEF tarball size: ${sizeMB} MB`);
    }
  })
  .catch(err => {
    console.error('Error creating tarball:', err);
    process.exit(1);
  });