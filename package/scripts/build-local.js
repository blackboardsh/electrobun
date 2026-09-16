#!/usr/bin/env node

import { resolve } from "node:path";
import { prepareLocalStack } from "./local-stack.js";

try {
	prepareLocalStack(resolve(import.meta.dirname, ".."));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
