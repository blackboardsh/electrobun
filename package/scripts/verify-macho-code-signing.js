#!/usr/bin/env node

import { readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";

const MH_MAGIC_64 = 0xfeedfacf;
const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;
const MACH_HEADER_64_SIZE = 32;
const SEGMENT_COMMAND_64_SIZE = 72;
const SECTION_64_SIZE = 80;

export const MIN_MACHO_HEADERPAD = 0x1000;

const cpuName = (cpuType) => {
	switch (cpuType >>> 0) {
		case 0x01000007:
			return "x86_64";
		case 0x0100000c:
			return "arm64";
		default:
			return `cpu-0x${(cpuType >>> 0).toString(16)}`;
	}
};

const requireRange = (buffer, offset, size, label) => {
	if (offset < 0 || size < 0 || offset + size > buffer.length) {
		throw new Error(`${label} extends beyond the Mach-O file`);
	}
};

export function inspectMachOCodeSigning(buffer) {
	requireRange(buffer, 0, MACH_HEADER_64_SIZE, "Mach-O header");
	if (buffer.readUInt32LE(0) !== MH_MAGIC_64) {
		throw new Error("expected a thin little-endian 64-bit Mach-O artifact");
	}

	const cpuType = buffer.readUInt32LE(4);
	const commandCount = buffer.readUInt32LE(16);
	const commandBytes = buffer.readUInt32LE(20);
	const commandEnd = MACH_HEADER_64_SIZE + commandBytes;
	requireRange(buffer, MACH_HEADER_64_SIZE, commandBytes, "Mach-O load commands");

	let commandOffset = MACH_HEADER_64_SIZE;
	let firstSectionOffset = Number.POSITIVE_INFINITY;
	let hasCodeSignature = false;

	for (let index = 0; index < commandCount; index += 1) {
		requireRange(buffer, commandOffset, 8, `load command ${index}`);
		const command = buffer.readUInt32LE(commandOffset);
		const commandSize = buffer.readUInt32LE(commandOffset + 4);
		if (commandSize < 8) {
			throw new Error(`load command ${index} has invalid size ${commandSize}`);
		}
		requireRange(buffer, commandOffset, commandSize, `load command ${index}`);

		if (command === LC_CODE_SIGNATURE) {
			hasCodeSignature = true;
		}

		if (command === LC_SEGMENT_64) {
			if (commandSize < SEGMENT_COMMAND_64_SIZE) {
				throw new Error(`segment command ${index} is truncated`);
			}
			const sectionCount = buffer.readUInt32LE(commandOffset + 64);
			const sectionsSize = sectionCount * SECTION_64_SIZE;
			if (SEGMENT_COMMAND_64_SIZE + sectionsSize > commandSize) {
				throw new Error(`segment command ${index} has truncated sections`);
			}

			for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
				const sectionOffset =
					commandOffset +
					SEGMENT_COMMAND_64_SIZE +
					sectionIndex * SECTION_64_SIZE;
				const sectionSize = buffer.readBigUInt64LE(sectionOffset + 40);
				const fileOffset = buffer.readUInt32LE(sectionOffset + 48);
				if (sectionSize > 0n && fileOffset > 0) {
					firstSectionOffset = Math.min(firstSectionOffset, fileOffset);
				}
			}
		}

		commandOffset += commandSize;
	}

	if (commandOffset !== commandEnd) {
		throw new Error(
			`load command sizes end at ${commandOffset}, expected ${commandEnd}`,
		);
	}
	if (!Number.isFinite(firstSectionOffset)) {
		throw new Error("Mach-O artifact has no file-backed sections");
	}
	if (firstSectionOffset < commandEnd) {
		throw new Error("Mach-O load commands overlap the first section");
	}

	return {
		architecture: cpuName(cpuType),
		commandEnd,
		firstSectionOffset,
		headerpad: firstSectionOffset - commandEnd,
		hasCodeSignature,
	};
}

export function verifyMachOCodeSigningCapacity(
	path,
	minimumHeaderpad = MIN_MACHO_HEADERPAD,
) {
	const inspection = inspectMachOCodeSigning(readFileSync(path));
	assertMachOCodeSigningCapacity(inspection, path, minimumHeaderpad);
	return inspection;
}

export function assertMachOCodeSigningCapacity(
	inspection,
	label = "Mach-O artifact",
	minimumHeaderpad = MIN_MACHO_HEADERPAD,
) {
	if (!inspection.hasCodeSignature && inspection.headerpad < minimumHeaderpad) {
		throw new Error(
			`${label}: unsigned ${inspection.architecture} Mach-O has ${inspection.headerpad} bytes of header padding; ` +
				`${minimumHeaderpad} bytes are required before code signing`,
		);
	}
}

const isMain =
	process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
	const paths = process.argv.slice(2);
	if (paths.length === 0) {
		console.error("usage: verify-macho-code-signing.js <Mach-O> [...]");
		process.exit(2);
	}

	try {
		for (const path of paths) {
			const result = verifyMachOCodeSigningCapacity(path);
			const capacity = result.hasCodeSignature
				? "existing LC_CODE_SIGNATURE"
				: `${result.headerpad} bytes headerpad`;
			console.log(`Verified ${path}: ${result.architecture}, ${capacity}`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
