#!/usr/bin/env node
"use strict";

// The electrobun front door: resolves the vendored (or installed) Hutch and
// forwards every argument to `hutch electrobun`, supplying this release's
// paired toolchain versions as defaults for unpinned projects.

const {
	resolveHutchBinary,
	runHutch,
} = require("./resolve-hutch.cjs");

function hutchArguments(args) {
	const forwarded = Array.from(args);
	if (forwarded[0] !== "init") return forwarded;

	const explicitTemplateChannel = forwarded.some(
		(argument) =>
			argument === "--beta" ||
			argument.startsWith("--channel="),
	);
	return explicitTemplateChannel
		? forwarded
		: [...forwarded, "--channel=stable"];
}

async function main(options = {}) {
	const args = hutchArguments(options.args ?? process.argv.slice(2));
	const environment = options.environment ?? process.env;
	const run = options.runHutch ?? runHutch;
	const binary = await resolveHutchBinary({
		...options,
		ensureGlobalHutch: args[0] === "init",
	});
	return run({ binary, args: ["electrobun", ...args], environment });
}

if (require.main === module) {
	main()
		.then((status) => {
			process.exitCode = status;
		})
		.catch((error) => {
			console.error(`electrobun: ${error.message}`);
			process.exitCode = 1;
		});
}

module.exports = { hutchArguments, main };
