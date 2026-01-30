#!/usr/bin/env node

import { platform } from "os";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

// Since this is sometimes run from a developer's package.json and sometimes from
// electrobun's playground package.json script by the root electrobun repo's package.json script
// we need to get the path to this file

// Get the nearest node_modules folder
// process.argv[1]:
/// macos: /Users/yoav/code/electrobun/playground/node_modules/.bin/electrobun
/// win: C:\Users\Yoav\code\electrobun\playground\node_modules\electrobun\dist\npmbin.js
const nodeModules = process.argv[1].split("node_modules")[0] + "node_modules";
const electrobunDir = join(nodeModules, "electrobun");

const DEV_CLI_PATH = join(
	electrobunDir,
	"dist",
	platform() === "win32" ? "electrobun.exe" : "electrobun",
);

async function main() {
	// For electrobun development, use local binary
	if (existsSync(DEV_CLI_PATH)) {
		spawnSync(DEV_CLI_PATH, process.argv.slice(2), { stdio: "inherit" });
		return;
	}
}

main().catch(console.error);
