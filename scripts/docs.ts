#!/usr/bin/env bun
/**
 * Cross-platform documentation utilities for Electrobun
 *
 * Usage: bun scripts/docs.ts <command>
 *
 * Commands:
 * - dev: Start documentation development server
 * - build: Build documentation for release
 */

import { execSync } from 'child_process';
import { styleText } from 'node:util';

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

function startDocsDev(): void {
  log('Starting documentation development server...', 'magenta');
  changeDirectory('documentation');
  runCommand('bun start');
}

function buildDocsRelease(): void {
  log('Building documentation for release...', 'magenta');
  changeDirectory('documentation');
  runCommand('bun run build');

  log('Documentation build completed successfully!', 'green');
}

function main() {
  const command = process.argv[2];
  const rootDir = process.cwd();

  if (!command) {
    log('Usage: bun scripts/docs.ts <command>', 'red');
    log('Available commands:', 'yellow');
    log('  dev - Start documentation development server', 'yellow');
    log('  build - Build documentation for release', 'yellow');
    process.exit(1);
  }

  log(`Starting documentation command: ${command}`, 'bold');

  switch (command) {
    case 'dev':
      startDocsDev();
      break;

    case 'build':
      buildDocsRelease();
      // Return to original directory
      process.chdir(rootDir);
      break;

    default:
      log(`Unknown command: ${command}`, 'red');
      process.exit(1);
  }
}

// Run the main function
main();
