#!/usr/bin/env bun

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Check if gh CLI is installed
function checkGhInstalled() {
  try {
    execSync('gh --version', { stdio: 'pipe' });
    return true;
  } catch (error) {
    return false;
  }
}

// Install gh CLI if needed
function installGhCli() {
  console.log('\n⚠️  GitHub CLI (gh) is not installed.');
  console.log('Please install it using one of these methods:\n');
  
  const platform = process.platform;
  
  if (platform === 'darwin') {
    console.log('macOS:');
    console.log('  brew install gh');
  } else if (platform === 'linux') {
    console.log('Ubuntu/Debian:');
    console.log('  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg');
    console.log('  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null');
    console.log('  sudo apt update && sudo apt install gh\n');
    
    console.log('Fedora/CentOS/RHEL:');
    console.log('  sudo dnf install gh\n');
    
    console.log('Arch Linux:');
    console.log('  sudo pacman -S github-cli');
  } else if (platform === 'win32') {
    console.log('Windows:');
    console.log('  winget install --id GitHub.cli');
    console.log('  # or');
    console.log('  choco install gh');
  }
  
  console.log('\nAfter installation, authenticate with:');
  console.log('  gh auth login\n');
  
  console.log('Or set GITHUB_TOKEN environment variable:');
  console.log('  export GITHUB_TOKEN="your-personal-access-token"\n');
  
  process.exit(1);
}

// Check for gh CLI
if (!checkGhInstalled()) {
  installGhCli();
}

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
  // First check if we're authenticated
  execSync('gh auth status', { stdio: 'pipe' });
  
  // Try to view the release with more details for debugging
  const releaseInfo = execSync(`gh release view ${tagName} --json tagName`, { encoding: 'utf8' });
  console.log(`Release ${tagName} found`);
} catch (error) {
  // Try listing releases to see what's available
  console.log('Failed to find release, listing available releases:');
  try {
    const releases = execSync('gh release list --limit 5', { encoding: 'utf8' });
    console.log(releases);
  } catch (listError) {
    console.error('Failed to list releases. Check your gh CLI authentication with: gh auth status');
  }
  
  console.error(`\nRelease ${tagName} not found. Please create the release first with:`);
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
    // Upload the artifact (--clobber will overwrite if it exists)
    execSync(`gh release upload ${tagName} "${artifactPath}" --clobber`, { stdio: 'inherit' });
    console.log(`  ✓ Uploaded ${artifact}`);
  } catch (error) {
    console.error(`  ✗ Failed to upload ${artifact}:`, error.message);
    console.error('Command failed:', error.message);
    
    // Try to get more details about the error
    try {
      const releaseDetails = execSync(`gh release view ${tagName}`, { encoding: 'utf8' });
      console.error('\nCurrent release details:');
      console.error(releaseDetails);
    } catch (e) {
      // Ignore
    }
    
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