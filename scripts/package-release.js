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

// Build in CI mode (skips CLI compilation since that happens in postinstall)
console.log('Building with CI mode...');
execSync('bun build.ts --release --ci', { stdio: 'inherit' });

// Build the CLI as a self-contained executable
console.log('Building CLI as self-contained executable...');
const binExt = platformName === 'win32' ? '.exe' : '';
execSync(`bun build src/cli/index.ts --compile --outfile dist/electrobun${binExt}`, { stdio: 'inherit' });

// Create the tarball
const distPath = path.join(__dirname, '..', 'dist');
const outputFile = path.join(__dirname, '..', `electrobun-${platformName}-${archName}.tar.gz`);

console.log(`Creating tarball: ${outputFile}`);

// Check if dist exists
if (!fs.existsSync(distPath)) {
  console.error('Error: dist directory not found');
  process.exit(1);
}

// Create tarball
tar.c({
  gzip: true,
  file: outputFile,
  cwd: distPath,
  portable: true
}, ['.'])
  .then(() => {
    console.log(`Successfully created ${outputFile}`);
    
    // Print file size
    const stats = fs.statSync(outputFile);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`Tarball size: ${sizeMB} MB`);
  })
  .catch(err => {
    console.error('Error creating tarball:', err);
    process.exit(1);
  });