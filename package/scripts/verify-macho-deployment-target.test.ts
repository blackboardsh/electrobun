import { describe, expect, test } from "bun:test";
import {
	assertMachODeploymentTargets,
	formatVersion,
	inspectMachODeploymentTargets,
	MACOS_DEPLOYMENT_TARGET,
} from "./verify-macho-deployment-target.js";
import { macosZigTarget } from "./macos-release.js";

const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;
const LC_BUILD_VERSION = 0x32;
const LC_VERSION_MIN_MACOSX = 0x24;
const PLATFORM_MACOS = 1;
const HEADER_SIZE = 32;

const encodeVersion = (major: number, minor = 0, patch = 0) =>
	(major << 16) | (minor << 8) | patch;

function makeThinMachO({
	version,
	legacy = false,
}: {
	version: [number, number?, number?];
	legacy?: boolean;
}) {
	const commandSize = legacy ? 16 : 24;
	const buffer = Buffer.alloc(HEADER_SIZE + commandSize);
	buffer.writeUInt32LE(MH_MAGIC_64, 0);
	buffer.writeUInt32LE(CPU_TYPE_ARM64, 4);
	buffer.writeUInt32LE(1, 16);
	buffer.writeUInt32LE(commandSize, 20);
	buffer.writeUInt32LE(
		legacy ? LC_VERSION_MIN_MACOSX : LC_BUILD_VERSION,
		HEADER_SIZE,
	);
	buffer.writeUInt32LE(commandSize, HEADER_SIZE + 4);
	if (legacy) {
		buffer.writeUInt32LE(encodeVersion(...version), HEADER_SIZE + 8);
	} else {
		buffer.writeUInt32LE(PLATFORM_MACOS, HEADER_SIZE + 8);
		buffer.writeUInt32LE(encodeVersion(...version), HEADER_SIZE + 12);
	}
	return buffer;
}

function makeUniversalMachO(slices: Buffer[]) {
	const entrySize = 20;
	const headerSize = 8 + slices.length * entrySize;
	const offsets: number[] = [];
	let offset = headerSize;
	for (const slice of slices) {
		offsets.push(offset);
		offset += slice.length;
	}

	const buffer = Buffer.alloc(offset);
	buffer.writeUInt32BE(0xcafebabe, 0);
	buffer.writeUInt32BE(slices.length, 4);
	for (const [index, slice] of slices.entries()) {
		const entry = 8 + index * entrySize;
		buffer.writeUInt32BE(CPU_TYPE_ARM64, entry);
		buffer.writeUInt32BE(offsets[index]!, entry + 8);
		buffer.writeUInt32BE(slice.length, entry + 12);
		slice.copy(buffer, offsets[index]);
	}
	return buffer;
}

describe("Mach-O deployment target verification", () => {
	test("uses versioned Zig target triples for every macOS architecture", () => {
		expect(macosZigTarget("arm64")).toBe("aarch64-macos.14.0");
		expect(macosZigTarget("x64")).toBe("x86_64-macos.14.0");
	});

	test("accepts the Electrobun macOS 14 release target", () => {
		const inspections = inspectMachODeploymentTargets(
			makeThinMachO({ version: [14, 0] }),
		);

		expect(formatVersion(inspections[0]!.deploymentTarget)).toBe("14.0");
		expect(() => assertMachODeploymentTargets(inspections)).not.toThrow();
	});

	test("rejects the macOS 14.8.3 regression from issue #434", () => {
		const inspections = inspectMachODeploymentTargets(
			makeThinMachO({ version: [14, 8, 3] }),
		);

		expect(() => assertMachODeploymentTargets(inspections)).toThrow(
			`requires macOS 14.8.3, exceeding Electrobun's supported ${MACOS_DEPLOYMENT_TARGET}`,
		);
	});

	test("accepts legacy LC_VERSION_MIN_MACOSX targets below the baseline", () => {
		const inspections = inspectMachODeploymentTargets(
			makeThinMachO({ version: [12, 0], legacy: true }),
		);

		expect(() => assertMachODeploymentTargets(inspections)).not.toThrow();
	});

	test("checks every slice in a universal Mach-O", () => {
		const inspections = inspectMachODeploymentTargets(
			makeUniversalMachO([
				makeThinMachO({ version: [14, 0] }),
				makeThinMachO({ version: [15, 0] }),
			]),
		);

		expect(inspections).toHaveLength(2);
		expect(() => assertMachODeploymentTargets(inspections, "universal")).toThrow(
			"requires macOS 15.0",
		);
	});

	test("ignores non-Mach-O files during release discovery", () => {
		expect(inspectMachODeploymentTargets(Buffer.from("not a binary"))).toEqual(
			[],
		);
	});
});
