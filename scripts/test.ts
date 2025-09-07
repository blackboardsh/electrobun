#!/usr/bin/env bun
/**
 * Cross-platform test runner for Electrobun
 *
 * Usage: bun scripts/test.ts
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
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
  const rootDir = process.cwd();

  log('Starting Electrobun tests...', 'bold');

  // Check submodules before running any build commands
  checkSubmodules();

  // Build Electrobun in development mode
  log('Building Electrobun in development mode...', 'magenta');
  runCommand('bun build:dev');
  runCommand('bun build:cli');

  // Install dependencies and run tests
  log('Installing test dependencies...', 'magenta');
  changeDirectory('tests');
  runCommand('npm install');

  log('Running tests...', 'magenta');
  runCommand('bun build:dev');
  runCommand('bun start');

  // Return to original directory
  process.chdir(rootDir);

  log('Tests completed successfully!', 'green');
}

// Run the main function
main();
