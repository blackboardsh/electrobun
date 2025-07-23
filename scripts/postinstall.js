#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { createWriteStream, createReadStream } = require('fs');
const { pipeline } = require('stream');
const { promisify } = require('util');
const tar = require('tar');
const { execSync } = require('child_process');

const pipelineAsync = promisify(pipeline);

const REPO = 'blackboardsh/electrobun';
const DIST_DIR = path.join(__dirname, '..', 'dist');

function getPlatform() {
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
  
  return {
    platform: platformMap[platform] || platform,
    arch: archMap[arch] || arch
  };
}

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'electrobun-installer' } }, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }
      
      const file = createWriteStream(dest);
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        resolve();
      });
      
      file.on('error', (err) => {
        fs.unlinkSync(dest);
        reject(err);
      });
    }).on('error', reject);
  });
}

async function getLatestRelease() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${REPO}/releases/latest`,
      headers: {
        'User-Agent': 'electrobun-installer',
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    
    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const release = JSON.parse(data);
          resolve(release.tag_name);
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  try {
    // Skip if running in CI or if binaries already exist
    if (process.env.CI || process.env.ELECTROBUN_SKIP_DOWNLOAD) {
      console.log('Skipping binary download');
      return;
    }
    
    // Check if dist already exists with binaries
    if (fs.existsSync(path.join(DIST_DIR, 'electrobun'))) {
      console.log('Binaries already exist, skipping download');
      return;
    }
    
    const { platform, arch } = getPlatform();
    const binaryName = `electrobun-${platform}-${arch}`;
    
    console.log(`Downloading Electrobun binaries for ${platform}-${arch}...`);
    
    // Get the latest release tag
    const version = process.env.ELECTROBUN_VERSION || await getLatestRelease();
    
    const downloadUrl = `https://github.com/${REPO}/releases/download/${version}/${binaryName}.tar.gz`;
    const tempFile = path.join(__dirname, `${binaryName}.tar.gz`);
    
    // Download the tarball
    console.log(`Downloading from ${downloadUrl}...`);
    await downloadFile(downloadUrl, tempFile);
    
    // Create dist directory if it doesn't exist
    if (!fs.existsSync(DIST_DIR)) {
      fs.mkdirSync(DIST_DIR, { recursive: true });
    }
    
    // Extract the tarball
    console.log('Extracting binaries...');
    await tar.x({
      file: tempFile,
      cwd: DIST_DIR
    });
    
    // Clean up
    fs.unlinkSync(tempFile);
    
    // Make binaries executable on Unix-like systems
    if (platform !== 'win32') {
      const binaries = ['electrobun', 'bun', 'launcher', 'extractor', 'bsdiff', 'bspatch', 'process_helper'];
      binaries.forEach(bin => {
        const binPath = path.join(DIST_DIR, bin);
        if (fs.existsSync(binPath)) {
          fs.chmodSync(binPath, 0o755);
        }
      });
    }
    
    console.log('Electrobun binaries installed successfully!');
    
  } catch (error) {
    console.error('Failed to download Electrobun binaries:', error.message);
    console.error('You can manually download from: https://github.com/blackboardsh/electrobun/releases');
    // Don't fail the installation
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}