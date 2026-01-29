#!/usr/bin/env bun

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
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
  'win32': 'win'
};

const archMap = {
  'x64': 'x64',
  'arm64': 'arm64'
};

const platformName = platformMap[platform] || platform;
// Always use x64 for Windows since we only build x64 Windows binaries
const archName = platform === 'win32' ? 'x64' : (archMap[arch] || arch);

console.log(`Packaging Electrobun for ${platformName}-${archName}...`);

// Build everything including CLI (no CI mode needed)
console.log('Building full release...');
try {
  execSync('bun build.ts --release', { stdio: 'inherit' });
} catch (error) {
  console.error('Build failed:', error.message);
  process.exit(1);
}

// Generate template embeddings before building CLI
console.log('Generating template embeddings...');
const templatesDir = path.join(__dirname, '..', '..', 'templates');
const outputFile = path.join(__dirname, '..', 'src', 'cli', 'templates', 'embedded.ts');

// Ensure the templates directory exists for embedded.ts
const templatesOutputDir = path.dirname(outputFile);
if (!fs.existsSync(templatesOutputDir)) {
    fs.mkdirSync(templatesOutputDir, { recursive: true });
}

// Verify that embedded.ts was created by build.ts, or create a minimal one
if (!fs.existsSync(outputFile)) {
    console.log('embedded.ts not found after build, creating minimal version...');
    fs.writeFileSync(outputFile, `// Auto-generated template embeddings
export const templates: Record<string, { name: string; files: Record<string, string> }> = {};

export function getTemplate(name: string) {
    return templates[name];
}

export function getTemplateNames(): string[] {
    return Object.keys(templates);
}
`);
} else {
    // If templates exist, run the generation through build.ts
    console.log('Templates found, generating embeddings...');
    // This is already done by the build.ts --release command above
}

// Build CLI binary
console.log('Building CLI binary...');
if (!fs.existsSync('bin')) {
    fs.mkdirSync('bin', { recursive: true });
}

// Use baseline target for Windows to ensure compatibility with ARM64 emulation
const compileTarget = platform === 'win32' ? '--target=bun-windows-x64-baseline' : '';
const vendoredBun = path.join('vendors', 'bun', platform === 'win32' ? 'bun.exe' : 'bun');

// Workaround for Windows 2025 runner cross-drive issues with Bun cache
if (platform === 'win32' && process.env.GITHUB_ACTIONS) {
    // Set Bun cache to same drive as workspace
    const workspaceDrive = process.cwd().substring(0, 2);
    const bunCacheDir = `${workspaceDrive}\\temp\\bun-cache`;
    console.log(`Setting BUN_INSTALL_CACHE_DIR to: ${bunCacheDir}`);

    // Ensure cache directory exists
    fs.mkdirSync(bunCacheDir, { recursive: true });

    // Set environment variable directly in the command for Windows
    execSync(`set "BUN_INSTALL_CACHE_DIR=${bunCacheDir}" && "${vendoredBun}" build src/cli/index.ts --compile ${compileTarget} --outfile bin/electrobun`, { stdio: 'inherit', shell: true });
} else {
    execSync(`"${vendoredBun}" build src/cli/index.ts --compile ${compileTarget} --outfile bin/electrobun`, { stdio: 'inherit' });
}

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

// Helper to build a Bun.Archive from entries in a base directory
async function buildArchiveFromEntries(baseDir, entries) {
  const files = {};
  for (const entry of entries) {
    const entryPath = path.join(baseDir, entry);
    const stat = fs.statSync(entryPath);
    if (stat.isDirectory()) {
      const glob = new Bun.Glob("**/*");
      for await (const relPath of glob.scan({ cwd: entryPath, dot: true })) {
        const fullPath = path.join(entryPath, relPath);
        const s = fs.statSync(fullPath);
        if (s.isFile() || s.isSymbolicLink()) {
          files[`${entry}/${relPath}`] = Bun.file(fullPath);
        }
      }
    } else {
      files[entry] = Bun.file(entryPath);
    }
  }
  return new Bun.Archive(files);
}

async function createTarballs() {
  // Validate that we have platform-specific binaries, not just npm files
  const expectedBinaries = [
    platform === 'win32' ? 'electrobun.exe' : 'electrobun',
    platform === 'win32' ? 'bun.exe' : 'bun'
  ];
  
  const missingBinaries = expectedBinaries.filter(binary => 
    !fs.existsSync(path.join(distPath, binary))
  );
  
  if (missingBinaries.length > 0) {
    console.error(`Error: Missing expected binaries in dist/: ${missingBinaries.join(', ')}`);
    console.error('This suggests the build failed or was incomplete.');
    console.error('Contents of dist/:');
    if (fs.existsSync(distPath)) {
      fs.readdirSync(distPath).forEach(file => console.error(`  ${file}`));
    } else {
      console.error('  (dist directory does not exist)');
    }
    process.exit(1);
  }
  
  console.log('Validation passed: Found expected platform binaries in dist/');

  // 1. Create CLI-only tarball
  const binPath = path.join(__dirname, '..', 'bin');
  const cliSrc = path.join(binPath, 'electrobun' + (platform === 'win32' ? '.exe' : ''));
  
  if (fs.existsSync(cliSrc)) {
    console.log(`Creating CLI tarball: ${cliOutputFile}`);
    
    // Create CLI tarball directly from bin directory
    const cliArchive = await buildArchiveFromEntries(binPath, ['electrobun' + (platform === 'win32' ? '.exe' : '')]);
    await Bun.write(cliOutputFile, cliArchive.bytes("gzip"));
    
    const cliStats = fs.statSync(cliOutputFile);
    const cliSizeMB = (cliStats.size / 1024 / 1024).toFixed(2);
    console.log(`CLI tarball size: ${cliSizeMB} MB`);
  }

  // 2. Create core binaries tarball (exclude CEF and CLI)
  const coreFiles = fs.readdirSync(distPath).filter(file => 
    file !== 'cef' && !file.startsWith('electrobun')
  );
  
  if (coreFiles.length > 0) {
    console.log(`Creating core binaries tarball: ${coreOutputFile}`);
    
    const coreArchive = await buildArchiveFromEntries(distPath, coreFiles);
    await Bun.write(coreOutputFile, coreArchive.bytes("gzip"));
    
    const coreStats = fs.statSync(coreOutputFile);
    const coreSizeMB = (coreStats.size / 1024 / 1024).toFixed(2);
    console.log(`Core binaries tarball size: ${coreSizeMB} MB`);
  }

  // 3. Create CEF tarball if CEF directory exists
  const cefPath = path.join(distPath, 'cef');
  if (fs.existsSync(cefPath)) {
    console.log(`Creating CEF tarball: ${cefOutputFile}`);
    
    const cefArchive = await buildArchiveFromEntries(distPath, ['cef']);
    await Bun.write(cefOutputFile, cefArchive.bytes("gzip"));
    
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