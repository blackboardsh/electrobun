#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const tar = require('tar');

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