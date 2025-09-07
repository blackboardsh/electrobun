#!/usr/bin/env bun
/**
 * Cross-platform build utilities for Electrobun
 *
 * Usage: bun scripts/build.ts <command>
 *
 * Commands:
 * - cli: Build the CLI executable
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
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

function ensureDirectory(dirPath: string): void {
  if (!existsSync(dirPath)) {
    log(`Creating directory: ${dirPath}`, 'blue');
    mkdirSync(dirPath, { recursive: true });
  }
}

function buildCli(): void {
  log('Building Electrobun CLI...', 'magenta');

  // Ensure bin directory exists (cross-platform replacement for mkdir -p)
  const binDir = join(process.cwd(), 'bin');
  ensureDirectory(binDir);

  // Build the CLI
  runCommand('bun build src/cli/index.ts --compile --outfile bin/electrobun');

  log('CLI build completed successfully!', 'green');
}

function main() {
  const command = process.argv[2];

  if (!command) {
    log('Usage: bun scripts/build.ts <command>', 'red');
    log('Available commands:', 'yellow');
    log('  cli - Build the CLI executable', 'yellow');
    process.exit(1);
  }

  log(`Starting build command: ${command}`, 'bold');

  switch (command) {
    case 'cli':
      buildCli();
      break;

    default:
      log(`Unknown command: ${command}`, 'red');
      process.exit(1);
  }

  log(`Build command completed successfully: ${command}`, 'green');
}

// Run the main function
main();
