#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { MACOS_DEPLOYMENT_TARGET } from "./macos-release.js";

export { MACOS_DEPLOYMENT_TARGET } from "./macos-release.js";

const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM = 0xcefaedfe;
const MH_CIGAM_64 = 0xcffaedfe;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const FAT_CIGAM = 0xbebafeca;
const FAT_CIGAM_64 = 0xbfbafeca;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;
const PLATFORM_MACOS = 1;

const requireRange = (buffer, offset, size, label) => {
	if (offset < 0 || size < 0 || offset + size > buffer.length) {
		throw new Error(`${label} extends beyond the Mach-O file`);
	}
};

const readUInt32 = (buffer, offset, littleEndian) => {
	requireRange(buffer, offset, 4, "32-bit Mach-O value");
	return littleEndian
		? buffer.readUInt32LE(offset)
		: buffer.readUInt32BE(offset);
};

const readUInt64 = (buffer, offset, littleEndian) => {
	requireRange(buffer, offset, 8, "64-bit Mach-O value");
	return littleEndian
		? buffer.readBigUInt64LE(offset)
		: buffer.readBigUInt64BE(offset);
};

const cpuName = (cpuType) => {
	switch (cpuType >>> 0) {
		case 0x01000007:
			return "x86_64";
		case 0x0100000c:
			return "arm64";
		case 7:
			return "x86";
		case 12:
			return "arm";
		default:
			return `cpu-0x${(cpuType >>> 0).toString(16)}`;
	}
};

export function decodeMachOVersion(value) {
	return {
		major: (value >>> 16) & 0xffff,
		minor: (value >>> 8) & 0xff,
		patch: value & 0xff,
	};
}

export function parseVersion(value) {
	if (typeof value !== "string" || !/^\d+(?:\.\d+){0,2}$/.test(value)) {
		throw new Error(`invalid macOS deployment target: ${value}`);
	}
	const [major = 0, minor = 0, patch = 0] = value
		.split(".")
		.map(Number);
	return { major, minor, patch };
}

export function formatVersion(version) {
	return version.patch === 0
		? `${version.major}.${version.minor}`
		: `${version.major}.${version.minor}.${version.patch}`;
}

export function compareVersions(left, right) {
	return (
		left.major - right.major ||
		left.minor - right.minor ||
		left.patch - right.patch
	);
}

const inspectThinMachO = (buffer, offset, size) => {
	requireRange(buffer, offset, size, "Mach-O slice");
	const magic = buffer.readUInt32BE(offset);
	const littleEndian = magic === MH_CIGAM || magic === MH_CIGAM_64;
	const is64 = magic === MH_MAGIC_64 || magic === MH_CIGAM_64;
	if (
		magic !== MH_MAGIC &&
		magic !== MH_MAGIC_64 &&
		magic !== MH_CIGAM &&
		magic !== MH_CIGAM_64
	) {
		throw new Error("expected a thin Mach-O slice");
	}

	const headerSize = is64 ? 32 : 28;
	requireRange(buffer, offset, headerSize, "Mach-O header");
	const architecture = cpuName(readUInt32(buffer, offset + 4, littleEndian));
	const commandCount = readUInt32(buffer, offset + 16, littleEndian);
	const commandBytes = readUInt32(buffer, offset + 20, littleEndian);
	const commandStart = offset + headerSize;
	const commandEnd = commandStart + commandBytes;
	requireRange(buffer, commandStart, commandBytes, "Mach-O load commands");
	if (commandEnd > offset + size) {
		throw new Error(`${architecture} load commands extend beyond their slice`);
	}

	let commandOffset = commandStart;
	let deploymentTarget = null;
	let sourceCommand = null;

	for (let index = 0; index < commandCount; index += 1) {
		requireRange(buffer, commandOffset, 8, `load command ${index}`);
		const command = readUInt32(buffer, commandOffset, littleEndian);
		const commandSize = readUInt32(buffer, commandOffset + 4, littleEndian);
		if (commandSize < 8 || commandOffset + commandSize > commandEnd) {
			throw new Error(`load command ${index} has invalid size ${commandSize}`);
		}

		if (command === LC_VERSION_MIN_MACOSX) {
			if (commandSize < 16) {
				throw new Error("LC_VERSION_MIN_MACOSX is truncated");
			}
			deploymentTarget = decodeMachOVersion(
				readUInt32(buffer, commandOffset + 8, littleEndian),
			);
			sourceCommand = "LC_VERSION_MIN_MACOSX";
		} else if (command === LC_BUILD_VERSION) {
			if (commandSize < 24) {
				throw new Error("LC_BUILD_VERSION is truncated");
			}
			const platform = readUInt32(buffer, commandOffset + 8, littleEndian);
			if (platform === PLATFORM_MACOS) {
				deploymentTarget = decodeMachOVersion(
					readUInt32(buffer, commandOffset + 12, littleEndian),
				);
				sourceCommand = "LC_BUILD_VERSION";
			}
		}

		commandOffset += commandSize;
	}

	if (commandOffset !== commandEnd) {
		throw new Error(
			`load command sizes end at ${commandOffset}, expected ${commandEnd}`,
		);
	}

	return { architecture, deploymentTarget, sourceCommand };
};

export function inspectMachODeploymentTargets(buffer) {
	if (buffer.length < 4) return [];
	const magic = buffer.readUInt32BE(0);

	if (
		magic === MH_MAGIC ||
		magic === MH_MAGIC_64 ||
		magic === MH_CIGAM ||
		magic === MH_CIGAM_64
	) {
		return [inspectThinMachO(buffer, 0, buffer.length)];
	}

	if (
		magic !== FAT_MAGIC &&
		magic !== FAT_MAGIC_64 &&
		magic !== FAT_CIGAM &&
		magic !== FAT_CIGAM_64
	) {
		return [];
	}

	const littleEndian = magic === FAT_CIGAM || magic === FAT_CIGAM_64;
	const is64 = magic === FAT_MAGIC_64 || magic === FAT_CIGAM_64;
	const architectureCount = readUInt32(buffer, 4, littleEndian);
	const entrySize = is64 ? 32 : 20;
	requireRange(
		buffer,
		8,
		architectureCount * entrySize,
		"universal Mach-O architecture table",
	);

	const inspections = [];
	for (let index = 0; index < architectureCount; index += 1) {
		const entryOffset = 8 + index * entrySize;
		const sliceOffset = is64
			? readUInt64(buffer, entryOffset + 8, littleEndian)
			: BigInt(readUInt32(buffer, entryOffset + 8, littleEndian));
		const sliceSize = is64
			? readUInt64(buffer, entryOffset + 16, littleEndian)
			: BigInt(readUInt32(buffer, entryOffset + 12, littleEndian));
		if (
			sliceOffset > BigInt(Number.MAX_SAFE_INTEGER) ||
			sliceSize > BigInt(Number.MAX_SAFE_INTEGER)
		) {
			throw new Error("universal Mach-O slice exceeds JavaScript's safe range");
		}
		inspections.push(
			inspectThinMachO(buffer, Number(sliceOffset), Number(sliceSize)),
		);
	}
	return inspections;
}

export function assertMachODeploymentTargets(
	inspections,
	label = "Mach-O artifact",
	maximum = MACOS_DEPLOYMENT_TARGET,
) {
	if (inspections.length === 0) {
		throw new Error(`${label}: expected a Mach-O artifact`);
	}
	const maximumVersion = parseVersion(maximum);
	for (const inspection of inspections) {
		if (!inspection.deploymentTarget) {
			throw new Error(
				`${label} (${inspection.architecture}): missing a macOS deployment target load command`,
			);
		}
		if (compareVersions(inspection.deploymentTarget, maximumVersion) > 0) {
			throw new Error(
				`${label} (${inspection.architecture}) requires macOS ${formatVersion(inspection.deploymentTarget)}, ` +
					`exceeding Electrobun's supported ${maximum}`,
			);
		}
	}
}

export function verifyMachODeploymentTarget(
	path,
	maximum = MACOS_DEPLOYMENT_TARGET,
) {
	const inspections = inspectMachODeploymentTargets(readFileSync(path));
	assertMachODeploymentTargets(inspections, path, maximum);
	return inspections;
}

const collectFiles = (path) => {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) return [];
	if (stat.isFile()) return [path];
	if (!stat.isDirectory()) return [];
	return readdirSync(path)
		.sort()
		.flatMap((entry) => collectFiles(join(path, entry)));
};

export function verifyMachORelease(paths, maximum = MACOS_DEPLOYMENT_TARGET) {
	const verified = [];
	const failures = [];
	for (const path of paths.flatMap(collectFiles)) {
		try {
			const buffer = readFileSync(path);
			const inspections = inspectMachODeploymentTargets(buffer);
			if (inspections.length === 0) continue;
			verified.push({ path, inspections });
			assertMachODeploymentTargets(inspections, path, maximum);
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (verified.length === 0) {
		throw new Error("release input contained no Mach-O artifacts");
	}
	if (failures.length > 0) {
		throw new Error(
			`Mach-O deployment target verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
		);
	}
	return verified;
}

const isMain =
	process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
	const paths = process.argv.slice(2);
	if (paths.length === 0) {
		console.error(
			"usage: verify-macho-deployment-target.js <Mach-O-or-directory> [...]",
		);
		process.exit(2);
	}

	try {
		const verified = verifyMachORelease(paths);
		for (const artifact of verified) {
			const targets = artifact.inspections
				.map(
					(slice) =>
						`${slice.architecture} macOS ${formatVersion(slice.deploymentTarget)}`,
				)
				.join(", ");
			console.log(`Verified ${artifact.path}: ${targets}`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
