#!/usr/bin/env node

import { execFileSync, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import process from "process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const platform = process.platform;
const arch = process.arch;

// Map Node.js platform/arch to our naming
const platformMap = {
	darwin: "darwin",
	linux: "linux",
	win32: "win",
};

const archMap = {
	x64: "x64",
	arm64: "arm64",
};

const platformName = platformMap[platform] || platform;
// Always use x64 for Windows since we only build x64 Windows binaries
const archName = platform === "win32" ? "x64" : archMap[arch] || arch;

console.log(`Packaging Electrobun for ${platformName}-${archName}...`);

// Build everything including CLI (no CI mode needed)
console.log("Building full release...");
try {
	const dashBinary = path.join(
		__dirname,
		"..",
		"vendors",
		"dash-cli",
		platform === "win32" ? "dash.exe" : "dash",
	);
	if (!fs.existsSync(dashBinary)) {
		throw new Error("Dash CLI is not vendored. Run npm run dash:vendor first.");
	}
	execFileSync(dashBinary, ["build.ts", "--release"], {
		cwd: path.join(__dirname, ".."),
		stdio: "inherit",
	});
} catch (error) {
	console.error("Build failed:", error.message);
	process.exit(1);
}

// Create separate tarballs for CLI, core binaries, and CEF
const distPath = path.join(__dirname, "..", "dist");
const cliOutputFile = path.join(
	__dirname,
	"..",
	`electrobun-cli-${platformName}-${archName}.tar.gz`,
);
const coreOutputFile = path.join(
	__dirname,
	"..",
	`electrobun-core-${platformName}-${archName}.tar.gz`,
);
const cefOutputFile = path.join(
	__dirname,
	"..",
	`electrobun-cef-${platformName}-${archName}.tar.gz`,
);

console.log(`Creating CLI tarball: ${cliOutputFile}`);

// Check if dist exists
if (!fs.existsSync(distPath)) {
	console.error("Error: dist directory not found");
	process.exit(1);
}

// Create a tar.gz file using system tar (preserves file permissions)
function createTarGz(tarGzPath, cwd, entries) {
	execSync(
		`tar -czf "${tarGzPath}" ${entries.map((e) => `"${e}"`).join(" ")}`,
		{
			cwd,
			stdio: "pipe",
		},
	);
}

async function createTarballs() {
	// Validate that we have platform-specific binaries, not just npm files
	const expectedBinaries = [
		platform === "win32" ? "dash.exe" : "dash",
		platform === "win32" ? "cottontail.exe" : "cottontail",
	];

	const missingBinaries = expectedBinaries.filter(
		(binary) => !fs.existsSync(path.join(distPath, binary)),
	);

	if (missingBinaries.length > 0) {
		console.error(
			`Error: Missing expected binaries in dist/: ${missingBinaries.join(", ")}`,
		);
		console.error("This suggests the build failed or was incomplete.");
		console.error("Contents of dist/:");
		if (fs.existsSync(distPath)) {
			fs.readdirSync(distPath).forEach((file) => console.error(`  ${file}`));
		} else {
			console.error("  (dist directory does not exist)");
		}
		process.exit(1);
	}

	console.log("Validation passed: Found expected platform binaries in dist/");

	// 1. Create CLI-only tarball
	const binPath = path.join(__dirname, "..", "bin");
	const dashName = "dash" + (platform === "win32" ? ".exe" : "");
	const cottontailName = "cottontail" + (platform === "win32" ? ".exe" : "");
	const cliSrc = path.join(binPath, dashName);

	if (fs.existsSync(cliSrc)) {
		console.log(`Creating CLI tarball: ${cliOutputFile}`);

		// Create CLI tarball directly from bin directory (system tar preserves permissions)
		createTarGz(cliOutputFile, binPath, [dashName, cottontailName]);

		const cliStats = fs.statSync(cliOutputFile);
		const cliSizeMB = (cliStats.size / 1024 / 1024).toFixed(2);
		console.log(`CLI tarball size: ${cliSizeMB} MB`);
	}

	// 2. Create core binaries tarball (exclude CEF and CLI)
	const coreFiles = fs
		.readdirSync(distPath)
		.filter((file) => file !== "cef" && file !== dashName);

	if (coreFiles.length > 0) {
		console.log(`Creating core binaries tarball: ${coreOutputFile}`);

		createTarGz(coreOutputFile, distPath, coreFiles);

		const coreStats = fs.statSync(coreOutputFile);
		const coreSizeMB = (coreStats.size / 1024 / 1024).toFixed(2);
		console.log(`Core binaries tarball size: ${coreSizeMB} MB`);
	}

	// 3. Create CEF tarball if CEF directory exists
	const cefPath = path.join(distPath, "cef");
	if (fs.existsSync(cefPath)) {
		console.log(`Creating CEF tarball: ${cefOutputFile}`);

		createTarGz(cefOutputFile, distPath, ["cef"]);

		const cefStats = fs.statSync(cefOutputFile);
		const cefSizeMB = (cefStats.size / 1024 / 1024).toFixed(2);
		console.log(`CEF tarball size: ${cefSizeMB} MB`);
	} else {
		console.log("No CEF directory found, skipping CEF tarball");
	}
}

createTarballs().catch((err) => {
	console.error("Error creating tarballs:", err);
	process.exit(1);
});
