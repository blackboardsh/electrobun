#!/usr/bin/env node

import { platform } from 'os';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

// Since this is sometimes run from a developer's package.json and sometimes from
// electrobun's playground package.json script by the root electrobun repo's package.json script
// we need to get the path to this file

// Get the directory name of the current script the .bin folder
const scriptDir = dirname(process.argv[1]);
// Go up one level from the bin directory to the node_modules folder and add the electrobun folder
const electrobunDir = join(dirname(scriptDir), 'electrobun');

const DEV_CLI_PATH = join(electrobunDir, 'dist', platform === 'win32' ? 'electrobun.exe' : 'electrobun');

console.log('npm bin!', DEV_CLI_PATH)

async function main() {
    // For electrobun development, use local binary
    if (existsSync(DEV_CLI_PATH)) {
      console.log('exits')
      spawnSync(DEV_CLI_PATH, process.argv.slice(2), { stdio: 'inherit' });
      return;
    }

    console.log('does not exit')

};

main().catch(console.error);