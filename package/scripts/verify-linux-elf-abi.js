#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const ELFCLASS32 = 1;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const ELFDATA2MSB = 2;
const SHT_GNU_VERNEED = 0x6ffffffe;
const PT_DYNAMIC = 2;

// Ubuntu 22.04 ships glibc 2.35 and GCC 11's libstdc++ runtime.
export const LINUX_ELF_ABI_BASELINE = Object.freeze({
	GLIBC: "2.35",
	GLIBCXX: "3.4.30",
	CXXABI: "1.3.13",
});

const requireRange = (buffer, offset, size, label) => {
	if (
		!Number.isSafeInteger(offset) ||
		!Number.isSafeInteger(size) ||
		offset < 0 ||
		size < 0 ||
		offset + size > buffer.length
	) {
		throw new Error(`${label} extends beyond the ELF file`);
	}
};

const safeNumber = (value, label) => {
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error(`${label} exceeds JavaScript's safe integer range`);
	}
	return Number(value);
};

const machineName = (machine) => {
	switch (machine) {
		case 3:
			return "x86";
		case 40:
			return "arm";
		case 62:
			return "x86_64";
		case 183:
			return "aarch64";
		default:
			return `machine-${machine}`;
	}
};

const makeReader = (buffer, littleEndian) => ({
	u16(offset, label = "16-bit ELF value") {
		requireRange(buffer, offset, 2, label);
		return littleEndian
			? buffer.readUInt16LE(offset)
			: buffer.readUInt16BE(offset);
	},
	u32(offset, label = "32-bit ELF value") {
		requireRange(buffer, offset, 4, label);
		return littleEndian
			? buffer.readUInt32LE(offset)
			: buffer.readUInt32BE(offset);
	},
	u64(offset, label = "64-bit ELF value") {
		requireRange(buffer, offset, 8, label);
		return safeNumber(
			littleEndian
				? buffer.readBigUInt64LE(offset)
				: buffer.readBigUInt64BE(offset),
			label,
		);
	},
});

const readCString = (buffer, offset, end, label) => {
	if (offset < 0 || offset >= end || end > buffer.length) {
		throw new Error(`${label} points outside its ELF string table`);
	}
	const terminator = buffer.indexOf(0, offset);
	if (terminator === -1 || terminator >= end) {
		throw new Error(`${label} is not NUL-terminated in its ELF string table`);
	}
	return buffer.toString("utf8", offset, terminator);
};

export function compareAbiVersions(left, right) {
	const leftParts = left.split(".").map(Number);
	const rightParts = right.split(".").map(Number);
	const length = Math.max(leftParts.length, rightParts.length);
	for (let index = 0; index < length; index += 1) {
		const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

export function parseAbiRequirement(name) {
	const match = /^(GLIBCXX|GLIBC|CXXABI)_(\d+(?:\.\d+)*)$/.exec(name);
	if (match) return { family: match[1], version: match[2], name };

	const unsupported = /^(GLIBCXX|GLIBC|CXXABI)_(.+)$/.exec(name);
	if (!unsupported) return null;
	return {
		family: unsupported[1],
		version: null,
		name,
		unsupported: true,
	};
}

const parseVersionRequirements = (
	buffer,
	reader,
	section,
	stringTable,
) => {
	requireRange(buffer, section.offset, section.size, "GNU version requirements");
	requireRange(
		buffer,
		stringTable.offset,
		stringTable.size,
		"GNU version string table",
	);

	const requirements = [];
	const sectionEnd = section.offset + section.size;
	const stringTableEnd = stringTable.offset + stringTable.size;
	let requirementOffset = section.offset;
	let requirementCount = 0;

	while (
		requirementOffset < sectionEnd &&
		(section.info === 0 || requirementCount < section.info)
	) {
		requireRange(buffer, requirementOffset, 16, "ELF version requirement");
		if (requirementOffset + 16 > sectionEnd) {
			throw new Error("ELF version requirement extends beyond its section");
		}

		const auxiliaryCount = reader.u16(
			requirementOffset + 2,
			"ELF version auxiliary count",
		);
		const auxiliaryRelativeOffset = reader.u32(
			requirementOffset + 8,
			"ELF version auxiliary offset",
		);
		const nextRequirement = reader.u32(
			requirementOffset + 12,
			"ELF next version requirement",
		);

		let auxiliaryOffset = requirementOffset + auxiliaryRelativeOffset;
		for (let index = 0; index < auxiliaryCount; index += 1) {
			requireRange(buffer, auxiliaryOffset, 16, "ELF version auxiliary entry");
			if (auxiliaryOffset + 16 > sectionEnd) {
				throw new Error(
					"ELF version auxiliary entry extends beyond its section",
				);
			}
			const nameOffset = reader.u32(
				auxiliaryOffset + 8,
				"ELF version name offset",
			);
			const nextAuxiliary = reader.u32(
				auxiliaryOffset + 12,
				"ELF next version auxiliary entry",
			);
			const name = readCString(
				buffer,
				stringTable.offset + nameOffset,
				stringTableEnd,
				"ELF version name",
			);
			const parsed = parseAbiRequirement(name);
			if (parsed) requirements.push(parsed);

			if (index + 1 < auxiliaryCount) {
				if (nextAuxiliary < 16) {
					throw new Error("ELF version auxiliary list ended prematurely");
				}
				auxiliaryOffset += nextAuxiliary;
			}
		}

		requirementCount += 1;
		if (nextRequirement === 0) break;
		if (nextRequirement < 16) {
			throw new Error("ELF version requirement list does not advance");
		}
		requirementOffset += nextRequirement;
	}

	if (section.info !== 0 && requirementCount !== section.info) {
		throw new Error(
			`ELF version requirement section declares ${section.info} entries but contains ${requirementCount}`,
		);
	}

	return requirements;
};

export function inspectElfAbiRequirements(buffer) {
	if (buffer.length < ELF_MAGIC.length || !buffer.subarray(0, 4).equals(ELF_MAGIC)) {
		return null;
	}
	if (buffer.length < 16) throw new Error("ELF identification header is truncated");

	const elfClass = buffer[4];
	if (elfClass !== ELFCLASS32 && elfClass !== ELFCLASS64) {
		throw new Error(`unsupported ELF class ${elfClass}`);
	}
	const dataEncoding = buffer[5];
	if (dataEncoding !== ELFDATA2LSB && dataEncoding !== ELFDATA2MSB) {
		throw new Error(`unsupported ELF data encoding ${dataEncoding}`);
	}

	const is64Bit = elfClass === ELFCLASS64;
	const littleEndian = dataEncoding === ELFDATA2LSB;
	const reader = makeReader(buffer, littleEndian);
	const headerSize = is64Bit ? 64 : 52;
	const sectionHeaderSize = is64Bit ? 64 : 40;
	requireRange(buffer, 0, headerSize, "ELF header");

	const sectionTableOffset = is64Bit
		? reader.u64(40, "ELF section table offset")
		: reader.u32(32, "ELF section table offset");
	const sectionEntrySize = reader.u16(
		is64Bit ? 58 : 46,
		"ELF section entry size",
	);
	const rawSectionCount = reader.u16(
		is64Bit ? 60 : 48,
		"ELF section count",
	);
	const machine = reader.u16(18, "ELF machine");
	const programTableOffset = is64Bit
		? reader.u64(32, "ELF program table offset")
		: reader.u32(28, "ELF program table offset");
	const programEntrySize = reader.u16(
		is64Bit ? 54 : 42,
		"ELF program entry size",
	);
	const programCount = reader.u16(is64Bit ? 56 : 44, "ELF program count");
	const minimumProgramEntrySize = is64Bit ? 56 : 32;
	let hasDynamicSegment = false;
	if (programCount === 0xffff) {
		throw new Error("extended ELF program counts are not supported");
	}
	if (programCount > 0) {
		if (programTableOffset === 0) {
			throw new Error("ELF declares program headers without a program table");
		}
		if (programEntrySize < minimumProgramEntrySize) {
			throw new Error(
				`ELF program entries are ${programEntrySize} bytes; expected at least ${minimumProgramEntrySize}`,
			);
		}
		requireRange(
			buffer,
			programTableOffset,
			programCount * programEntrySize,
			"ELF program table",
		);
		for (let index = 0; index < programCount; index += 1) {
			if (
				reader.u32(
					programTableOffset + index * programEntrySize,
					`ELF program header ${index} type`,
				) === PT_DYNAMIC
			) {
				hasDynamicSegment = true;
			}
		}
	}

	if (sectionTableOffset === 0) {
		if (rawSectionCount !== 0) {
			throw new Error("ELF declares sections without a section table");
		}
		if (hasDynamicSegment) {
			throw new Error(
				"sectionless dynamically linked ELF cannot be ABI-verified",
			);
		}
		return {
			architecture: machineName(machine),
			class: is64Bit ? 64 : 32,
			endianness: littleEndian ? "little" : "big",
			requirements: [],
		};
	}
	if (sectionEntrySize < sectionHeaderSize) {
		throw new Error(
			`ELF section entries are ${sectionEntrySize} bytes; expected at least ${sectionHeaderSize}`,
		);
	}

	const readSection = (index) => {
		const offset = sectionTableOffset + index * sectionEntrySize;
		requireRange(buffer, offset, sectionHeaderSize, `ELF section ${index}`);
		return is64Bit
			? {
					type: reader.u32(offset + 4),
					offset: reader.u64(offset + 24),
					size: reader.u64(offset + 32),
					link: reader.u32(offset + 40),
					info: reader.u32(offset + 44),
				}
			: {
					type: reader.u32(offset + 4),
					offset: reader.u32(offset + 16),
					size: reader.u32(offset + 20),
					link: reader.u32(offset + 24),
					info: reader.u32(offset + 28),
				};
	};

	let sectionCount = rawSectionCount;
	if (sectionCount === 0) {
		sectionCount = readSection(0).size;
	}
	if (sectionCount === 0) {
		return {
			architecture: machineName(machine),
			class: is64Bit ? 64 : 32,
			endianness: littleEndian ? "little" : "big",
			requirements: [],
		};
	}
	if (!Number.isSafeInteger(sectionCount) || sectionCount > 1_000_000) {
		throw new Error(`unreasonable ELF section count ${sectionCount}`);
	}
	requireRange(
		buffer,
		sectionTableOffset,
		sectionCount * sectionEntrySize,
		"ELF section table",
	);

	const sections = Array.from({ length: sectionCount }, (_, index) =>
		readSection(index),
	);
	const requirements = [];
	for (const section of sections) {
		if (section.type !== SHT_GNU_VERNEED) continue;
		if (section.link >= sections.length) {
			throw new Error(
				`ELF version requirement section links to missing section ${section.link}`,
			);
		}
		requirements.push(
			...parseVersionRequirements(
				buffer,
				reader,
				section,
				sections[section.link],
			),
		);
	}

	return {
		architecture: machineName(machine),
		class: is64Bit ? 64 : 32,
		endianness: littleEndian ? "little" : "big",
		requirements,
	};
}

export function maximumAbiRequirements(requirements) {
	const maximums = {};
	for (const requirement of requirements) {
		if (!requirement.version) continue;
		const current = maximums[requirement.family];
		if (!current || compareAbiVersions(requirement.version, current) > 0) {
			maximums[requirement.family] = requirement.version;
		}
	}
	return maximums;
}

export function assertElfAbiBaseline(
	inspection,
	label = "ELF artifact",
	baseline = LINUX_ELF_ABI_BASELINE,
) {
	const maximums = maximumAbiRequirements(inspection.requirements);
	const violations = [];
	for (const requirement of inspection.requirements) {
		if (requirement.unsupported) {
			violations.push(
				`requires unsupported GNU ABI tag ${requirement.name}`,
			);
		}
	}
	for (const [family, maximum] of Object.entries(baseline)) {
		const required = maximums[family];
		if (required && compareAbiVersions(required, maximum) > 0) {
			violations.push(
				`requires ${family}_${required}, exceeding the Ubuntu 22.04 baseline ${family}_${maximum}`,
			);
		}
	}
	if (violations.length > 0) {
		throw new Error(
			`${label} (${inspection.architecture}) ${violations.join("; ")}`,
		);
	}
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

export function verifyLinuxElfRelease(
	paths,
	baseline = LINUX_ELF_ABI_BASELINE,
) {
	const verified = [];
	const failures = [];
	for (const path of paths.flatMap(collectFiles)) {
		let inspection;
		try {
			inspection = inspectElfAbiRequirements(readFileSync(path));
		} catch (error) {
			failures.push(`${path}: ${error instanceof Error ? error.message : error}`);
			continue;
		}
		if (!inspection) continue;
		verified.push({ path, inspection });
		try {
			assertElfAbiBaseline(inspection, path, baseline);
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (verified.length === 0) {
		throw new Error("release input contained no ELF artifacts");
	}
	if (failures.length > 0) {
		throw new Error(
			`Linux ELF ABI verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
		);
	}
	return verified;
}

const isMain =
	process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
	const paths = process.argv.slice(2);
	if (paths.length === 0) {
		console.error("usage: verify-linux-elf-abi.js <ELF-or-directory> [...]");
		process.exit(2);
	}

	try {
		const verified = verifyLinuxElfRelease(paths);
		for (const artifact of verified) {
			const maximums = maximumAbiRequirements(
				artifact.inspection.requirements,
			);
			const summary = Object.entries(maximums)
				.map(([family, version]) => `${family}_${version}`)
				.join(", ");
			console.log(
				`Verified ${artifact.path}: ${artifact.inspection.architecture}` +
					(summary ? ` (${summary})` : " (no versioned GNU ABI requirements)"),
			);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
