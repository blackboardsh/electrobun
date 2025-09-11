#!/usr/bin/env bun
/**
 * Cross-platform playground development for Electrobun
 *
 * Usage: bun scripts/playground.ts <command>
 *
 * Commands:
 * - playground: Build and run playground
 * - playground:linux: Build and run playground with npm link (Linux/macOS)
 * - playground:clean: Clean and rebuild everything
 * - playground:rerun: Just run playground without rebuilding
 * - playground:canary: Build and run in canary mode
 * - playground:template: Build and run interactive-playground template
 */

import { execSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { styleText } from 'node:util';
import { join } from 'path';

function log(message: string, style?: Parameters<typeof styleText>[0]) {
  console.log(style ? styleText(style, message) : message);
}

function runCommand(command: string, cwd?: string): void {
  const options = cwd
    ? { cwd, stdio: 'inherit' as const }
    : { stdio: 'inherit' as const };
  log(`Running: ${command}`, 'cyan');
  try {
    execSync(command, options);
  } catch (error) {
    log(`Error running command: ${command}`, 'red');
    process.exit(1);
  }
}

function safeRemoveDirectory(dirPath: string): void {
  if (existsSync(dirPath)) {
    log(`Removing directory: ${dirPath}`, 'yellow');
    try {
      rmSync(dirPath, { recursive: true, force: true });
      log(`Successfully removed: ${dirPath}`, 'green');
    } catch (error) {
      log(`Error removing directory ${dirPath}: ${error}`, 'red');
      process.exit(1);
    }
  } else {
    log(`Directory does not exist: ${dirPath}`, 'yellow');
  }
}

function changeDirectory(dir: string): void {
  log(`Changing directory to: ${dir}`, 'blue');
  try {
    process.chdir(dir);
    log(`Current directory: ${process.cwd()}`, 'green');
  } catch (error) {
    log(`Error changing directory to ${dir}: ${error}`, 'red');
    process.exit(1);
  }
}

function buildElectrobun(mode: 'dev' | 'release' = 'dev'): void {
  log(`Building Electrobun in ${mode} mode...`, 'magenta');
  const originalCwd = process.cwd();

  // Ensure we're in the root directory
  process.chdir(originalCwd);

  runCommand(`bun build:${mode}`);
  runCommand('bun build:cli');
}

function installDependencies(directory: string): void {
  log(`Installing dependencies in ${directory}...`, 'magenta');
  const originalCwd = process.cwd();

  changeDirectory(directory);
  runCommand('npm install');

  // Return to original directory
  process.chdir(originalCwd);
}

function runPlayground(
  directory: string,
  buildMode: 'dev' | 'canary' = 'dev'
): void {
  log(`Running playground in ${directory}...`, 'magenta');
  const originalCwd = process.cwd();

  changeDirectory(directory);

  if (buildMode === 'canary') {
    runCommand('bun build:canary');
    runCommand('bun start:canary');
  } else {
    runCommand('bun build:dev');
    runCommand('bun start');
  }

  // Return to original directory
  process.chdir(originalCwd);
}

function checkSubmodules(): void {
  const zstdPath = join(process.cwd(), 'src', 'bsdiff', 'zstd', '.git');
  if (!existsSync(zstdPath)) {
    log('⚠️  Git submodules not initialized!', 'red');
    log('Please run: git submodule update --init --recursive', 'yellow');
    log('This is required for the build to work properly.', 'yellow');
    process.exit(1);
  }
}

function main() {
  const command = process.argv[2];
  const rootDir = process.cwd();

  // Check submodules before running any build commands
  checkSubmodules();

  if (!command) {
    log('Usage: bun scripts/playground.ts <command>', 'red');
    log('Available commands:', 'yellow');
    log('  playground - Build and run playground', 'yellow');
    log(
      '  playground:linux - Build and run playground with npm link',
      'yellow'
    );
    log('  playground:clean - Clean and rebuild everything', 'yellow');
    log(
      '  playground:rerun - Just run playground without rebuilding',
      'yellow'
    );
    log('  playground:canary - Build and run in canary mode', 'yellow');
    log(
      '  playground:template - Build and run interactive-playground template',
      'yellow'
    );
    process.exit(1);
  }

  log(`Starting command: ${command}`, 'bold');

  switch (command) {
    case 'playground':
      buildElectrobun('dev');
      installDependencies('playground');
      runPlayground('playground');
      break;

    case 'playground:linux':
      buildElectrobun('dev');

      // Create npm link
      log('Creating npm link...', 'magenta');
      runCommand('npm link');

      // Use npm link in playground
      changeDirectory('playground');
      runCommand('npm link electrobun');
      runPlayground('.', 'dev');
      break;

    case 'playground:clean':
      // Clean playground node_modules
      const playgroundNodeModules = join(rootDir, 'playground', 'node_modules');
      safeRemoveDirectory(playgroundNodeModules);

      // Build Electrobun first (before npm install creates the symlink)
      buildElectrobun('dev');

      // Reinstall dependencies (creates symlink to local electrobun)
      installDependencies('playground');

      // Run playground
      runPlayground('playground');
      break;

    case 'playground:rerun':
      runPlayground('playground');
      break;

    case 'playground:canary':
      buildElectrobun('release');
      installDependencies('playground');
      runPlayground('playground', 'canary');
      break;

    case 'playground:template':
      buildElectrobun('dev');
      installDependencies('templates/interactive-playground');
      runPlayground('templates/interactive-playground');
      break;

    default:
      log(`Unknown command: ${command}`, 'red');
      process.exit(1);
  }

  log(`Command completed successfully: ${command}`, 'green');
}

// Run the main function
main();
