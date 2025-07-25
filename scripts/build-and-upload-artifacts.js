#!/usr/bin/env bun

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read package.json to get the version
const packageJsonPath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const version = packageJson.version;
const tagName = `v${version}`;

console.log(`Building and uploading artifacts for version ${version} (tag: ${tagName})`);

// Get platform and architecture info
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

console.log(`Platform: ${platformName}, Architecture: ${archName}`);

// Step 1: Build the release artifacts
console.log('\n1. Building release artifacts...');
try {
  execSync('bun scripts/package-release.js', { stdio: 'inherit' });
} catch (error) {
  console.error('Build failed:', error.message);
  process.exit(1);
}

// Step 2: Check if the artifacts exist
const artifacts = [
  `electrobun-cli-${platformName}-${archName}.tar.gz`,
  `electrobun-core-${platformName}-${archName}.tar.gz`,
  `electrobun-cef-${platformName}-${archName}.tar.gz`
];

const existingArtifacts = artifacts.filter(artifact => 
  fs.existsSync(path.join(__dirname, '..', artifact))
);

if (existingArtifacts.length === 0) {
  console.error('No artifacts found to upload');
  process.exit(1);
}

console.log('\nFound artifacts:');
existingArtifacts.forEach(artifact => console.log(`  - ${artifact}`));

// Step 3: Check if release exists
console.log(`\n2. Checking if release ${tagName} exists...`);
try {
  execSync(`gh release view ${tagName}`, { stdio: 'pipe' });
  console.log(`Release ${tagName} found`);
} catch (error) {
  console.error(`Release ${tagName} not found. Please create the release first with:`);
  console.error(`  git tag ${tagName} && git push origin ${tagName}`);
  console.error(`  gh release create ${tagName}`);
  console.error('\nOr wait for CI to create it automatically');
  process.exit(1);
}

// Step 4: Upload artifacts
console.log('\n3. Uploading artifacts to release...');
for (const artifact of existingArtifacts) {
  const artifactPath = path.join(__dirname, '..', artifact);
  console.log(`Uploading ${artifact}...`);
  
  try {
    // First, try to delete existing artifact if it exists (in case we're re-uploading)
    execSync(`gh release delete-asset ${tagName} ${artifact} -y`, { stdio: 'pipe' }).catch(() => {
      // Ignore error if asset doesn't exist
    });
    
    // Upload the artifact
    execSync(`gh release upload ${tagName} "${artifactPath}" --clobber`, { stdio: 'inherit' });
    console.log(`  ✓ Uploaded ${artifact}`);
  } catch (error) {
    console.error(`  ✗ Failed to upload ${artifact}:`, error.message);
    process.exit(1);
  }
}

// Step 5: Clean up local artifacts
console.log('\n4. Cleaning up local artifacts...');
for (const artifact of existingArtifacts) {
  const artifactPath = path.join(__dirname, '..', artifact);
  try {
    fs.unlinkSync(artifactPath);
    console.log(`  ✓ Removed ${artifact}`);
  } catch (error) {
    console.error(`  ✗ Failed to remove ${artifact}:`, error.message);
  }
}

console.log('\n✅ Successfully built and uploaded artifacts!');
console.log(`\nView the release at: https://github.com/blackboardsh/electrobun/releases/tag/${tagName}`);