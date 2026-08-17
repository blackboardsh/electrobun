import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertElfAbiBaseline,
	compareAbiVersions,
	inspectElfAbiRequirements,
	LINUX_ELF_ABI_BASELINE,
	maximumAbiRequirements,
	verifyLinuxElfRelease,
} from "./verify-linux-elf-abi.js";

const SHT_STRTAB = 3;
const SHT_GNU_VERNEED = 0x6ffffffe;
const PT_DYNAMIC = 2;
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function makeElf({
	versions = [],
	bits = 64,
	littleEndian = true,
	sectionlessDynamic = false,
}: {
	versions?: string[];
	bits?: 32 | 64;
	littleEndian?: boolean;
	sectionlessDynamic?: boolean;
} = {}) {
	const is64Bit = bits === 64;
	const headerSize = is64Bit ? 64 : 52;
	const sectionHeaderSize = is64Bit ? 64 : 40;
	const writeU16 = (buffer: Buffer, value: number, offset: number) =>
		littleEndian
			? buffer.writeUInt16LE(value, offset)
			: buffer.writeUInt16BE(value, offset);
	const writeU32 = (buffer: Buffer, value: number, offset: number) =>
		littleEndian
			? buffer.writeUInt32LE(value, offset)
			: buffer.writeUInt32BE(value, offset);
	const writeU64 = (buffer: Buffer, value: number, offset: number) =>
		littleEndian
			? buffer.writeBigUInt64LE(BigInt(value), offset)
			: buffer.writeBigUInt64BE(BigInt(value), offset);

	if (versions.length === 0) {
		const programHeaderSize = is64Bit ? 56 : 32;
		const buffer = Buffer.alloc(
			headerSize + (sectionlessDynamic ? programHeaderSize : 0),
		);
		buffer.set([0x7f, 0x45, 0x4c, 0x46, is64Bit ? 2 : 1, littleEndian ? 1 : 2]);
		writeU16(buffer, is64Bit ? 183 : 3, 18);
		if (sectionlessDynamic) {
			if (is64Bit) {
				writeU64(buffer, headerSize, 32);
				writeU16(buffer, programHeaderSize, 54);
				writeU16(buffer, 1, 56);
			} else {
				writeU32(buffer, headerSize, 28);
				writeU16(buffer, programHeaderSize, 42);
				writeU16(buffer, 1, 44);
			}
			writeU32(buffer, PT_DYNAMIC, headerSize);
		}
		return buffer;
	}

	const strings = ["libc.so.6", ...versions];
	const stringOffsets = new Map<string, number>();
	let stringData = "\0";
	for (const value of strings) {
		stringOffsets.set(value, Buffer.byteLength(stringData));
		stringData += `${value}\0`;
	}
	const stringTable = Buffer.from(stringData);
	const versionRequirements = Buffer.alloc(16 + versions.length * 16);
	writeU16(versionRequirements, 1, 0);
	writeU16(versionRequirements, versions.length, 2);
	writeU32(versionRequirements, stringOffsets.get("libc.so.6")!, 4);
	writeU32(versionRequirements, 16, 8);
	for (const [index, version] of versions.entries()) {
		const offset = 16 + index * 16;
		writeU32(versionRequirements, stringOffsets.get(version)!, offset + 8);
		writeU32(
			versionRequirements,
			index + 1 < versions.length ? 16 : 0,
			offset + 12,
		);
	}

	const align = (value: number) => (value + 7) & ~7;
	const stringTableOffset = headerSize;
	const versionRequirementsOffset = align(
		stringTableOffset + stringTable.length,
	);
	const sectionTableOffset = align(
		versionRequirementsOffset + versionRequirements.length,
	);
	const buffer = Buffer.alloc(sectionTableOffset + 3 * sectionHeaderSize);
	buffer.set([0x7f, 0x45, 0x4c, 0x46, is64Bit ? 2 : 1, littleEndian ? 1 : 2]);
	writeU16(buffer, is64Bit ? 183 : 3, 18);
	if (is64Bit) {
		writeU64(buffer, sectionTableOffset, 40);
		writeU16(buffer, sectionHeaderSize, 58);
		writeU16(buffer, 3, 60);
	} else {
		writeU32(buffer, sectionTableOffset, 32);
		writeU16(buffer, sectionHeaderSize, 46);
		writeU16(buffer, 3, 48);
	}
	stringTable.copy(buffer, stringTableOffset);
	versionRequirements.copy(buffer, versionRequirementsOffset);

	const writeSection = (
		index: number,
		{ type, offset, size, link = 0, info = 0 }: {
			type: number;
			offset: number;
			size: number;
			link?: number;
			info?: number;
		},
	) => {
		const section = sectionTableOffset + index * sectionHeaderSize;
		writeU32(buffer, type, section + 4);
		if (is64Bit) {
			writeU64(buffer, offset, section + 24);
			writeU64(buffer, size, section + 32);
			writeU32(buffer, link, section + 40);
			writeU32(buffer, info, section + 44);
		} else {
			writeU32(buffer, offset, section + 16);
			writeU32(buffer, size, section + 20);
			writeU32(buffer, link, section + 24);
			writeU32(buffer, info, section + 28);
		}
	};
	writeSection(1, {
		type: SHT_STRTAB,
		offset: stringTableOffset,
		size: stringTable.length,
	});
	writeSection(2, {
		type: SHT_GNU_VERNEED,
		offset: versionRequirementsOffset,
		size: versionRequirements.length,
		link: 1,
		info: 1,
	});
	return buffer;
}

describe("Linux ELF ABI verification", () => {
	test("builds the Linux ARM64 extractor for the generic baseline CPU", () => {
		const buildSource = readFileSync(
			new URL("../build.ts", import.meta.url),
			"utf8",
		);
		const start = buildSource.indexOf("async function buildSelfExtractor()");
		const end = buildSource.indexOf("async function buildPreload()", start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		expect(buildSource.slice(start, end)).toMatch(
			/OS === "linux" && ARCH === "arm64"\s*\? \["-Dtarget=aarch64-linux-gnu", "-Dcpu=baseline"\]/,
		);
	});

	test("compares every numeric ABI version component", () => {
		expect(compareAbiVersions("2.35", "2.34.9")).toBeGreaterThan(0);
		expect(compareAbiVersions("3.4.30", "3.4.30.0")).toBe(0);
		expect(compareAbiVersions("1.3.9", "1.3.13")).toBeLessThan(0);
	});

	test("checks the maximum requirement even when a lower version appears first", () => {
		const inspection = inspectElfAbiRequirements(
			makeElf({ versions: ["GLIBCXX_3.4.32", "GLIBCXX_3.4.33"] }),
		)!;

		expect(maximumAbiRequirements(inspection.requirements)).toEqual({
			GLIBCXX: "3.4.33",
		});
		expect(() => assertElfAbiBaseline(inspection, "fixture.so")).toThrow(
			"requires GLIBCXX_3.4.33",
		);
	});

	test("parses GNU requirements from 64-bit little-endian ELF files", () => {
		const inspection = inspectElfAbiRequirements(
			makeElf({
				versions: ["GLIBC_2.39", "GLIBCXX_3.4.32", "CXXABI_1.3.14"],
			}),
		)!;

		expect(inspection.architecture).toBe("aarch64");
		expect(maximumAbiRequirements(inspection.requirements)).toEqual(
			LINUX_ELF_ABI_BASELINE,
		);
		expect(() => assertElfAbiBaseline(inspection)).not.toThrow();
	});

	test("parses 32-bit big-endian ELF files", () => {
		const inspection = inspectElfAbiRequirements(
			makeElf({ versions: ["GLIBC_2.17"], bits: 32, littleEndian: false }),
		)!;

		expect(inspection).toMatchObject({
			architecture: "x86",
			class: 32,
			endianness: "big",
		});
		expect(inspection.requirements.map(({ name }) => name)).toEqual([
			"GLIBC_2.17",
		]);
	});

	test.each([
		["GLIBC_2.40", "GLIBC_2.39"],
		["GLIBCXX_3.4.33", "GLIBCXX_3.4.32"],
		["CXXABI_1.3.15", "CXXABI_1.3.14"],
	])("rejects %s above the Noble baseline", (required, maximum) => {
		const inspection = inspectElfAbiRequirements(
			makeElf({ versions: [required] }),
		)!;

		expect(() => assertElfAbiBaseline(inspection, "fixture.so")).toThrow(
			`requires ${required}, exceeding the Ubuntu 24.04 baseline ${maximum}`,
		);
	});

	test("recursively verifies extensionless, shared, and static ELF artifacts", () => {
		const directory = mkdtempSync(join(tmpdir(), "electrobun-elf-abi-"));
		temporaryDirectories.push(directory);
		mkdirSync(join(directory, "cef"));
		writeFileSync(
			join(directory, "launcher"),
			makeElf({ versions: ["GLIBC_2.35"] }),
		);
		writeFileSync(
			join(directory, "cef", "libcef.so"),
			makeElf({ versions: ["GLIBC_2.17"] }),
		);
		writeFileSync(join(directory, "static-helper"), makeElf());
		writeFileSync(join(directory, "resources.pak"), "not an ELF");

		const verified = verifyLinuxElfRelease([directory]);

		expect(verified.map(({ path }) => path)).toEqual([
			join(directory, "cef", "libcef.so"),
			join(directory, "launcher"),
			join(directory, "static-helper"),
		]);
	});

	test("rejects GNU ABI tags that cannot be compared to the baseline", () => {
		const inspection = inspectElfAbiRequirements(
			makeElf({ versions: ["GLIBC_ABI_DT_RELR"] }),
		)!;

		expect(() => assertElfAbiBaseline(inspection, "fixture.so")).toThrow(
			"requires unsupported GNU ABI tag GLIBC_ABI_DT_RELR",
		);
	});

	test("fails closed for dynamically linked ELFs without section headers", () => {
		expect(() =>
			inspectElfAbiRequirements(makeElf({ sectionlessDynamic: true })),
		).toThrow("sectionless dynamically linked ELF cannot be ABI-verified");
	});

	test("reports every incompatible ELF in a release tree", () => {
		const directory = mkdtempSync(join(tmpdir(), "electrobun-elf-abi-"));
		temporaryDirectories.push(directory);
		writeFileSync(
			join(directory, "libNativeWrapper.so"),
			makeElf({ versions: ["GLIBC_2.40"] }),
		);
		writeFileSync(
			join(directory, "libwebgpu_dawn.so"),
			makeElf({ versions: ["GLIBCXX_3.4.33"] }),
		);

		expect(() => verifyLinuxElfRelease([directory])).toThrow(
			new RegExp(
				"libNativeWrapper[.]so[\\s\\S]+GLIBC_2[.]40[\\s\\S]+libwebgpu_dawn[.]so[\\s\\S]+GLIBCXX_3[.]4[.]33",
			),
		);
	});

	test("ignores non-ELF files and rejects truncated ELF inputs", () => {
		expect(inspectElfAbiRequirements(Buffer.from("not a binary"))).toBeNull();
		expect(() =>
			inspectElfAbiRequirements(Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
		).toThrow("identification header is truncated");
	});
});
