import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertMachOArchitecture,
	assertMachODeploymentTargets,
	formatVersion,
	inspectMachODeploymentTargets,
	MACOS_DEPLOYMENT_TARGET,
	verifyMachORelease,
} from "./verify-macho-deployment-target.js";
import { macosNativeArchitecture, macosZigTarget } from "./macos-release.js";

const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_TYPE_X86_64 = 0x01000007;
const LC_BUILD_VERSION = 0x32;
const LC_VERSION_MIN_MACOSX = 0x24;
const PLATFORM_MACOS = 1;
const HEADER_SIZE = 32;

const encodeVersion = (major: number, minor = 0, patch = 0) =>
	(major << 16) | (minor << 8) | patch;

function makeThinMachO({
	version,
	legacy = false,
	cpuType = CPU_TYPE_ARM64,
}: {
	version: [number, number?, number?];
	legacy?: boolean;
	cpuType?: number;
}) {
	const commandSize = legacy ? 16 : 24;
	const buffer = Buffer.alloc(HEADER_SIZE + commandSize);
	buffer.writeUInt32LE(MH_MAGIC_64, 0);
	buffer.writeUInt32LE(cpuType, 4);
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
		buffer.writeUInt32BE(slice.readUInt32LE(4), entry);
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
		expect(macosNativeArchitecture("x64")).toBe("x86_64");
		expect(macosNativeArchitecture("arm64")).toBe("arm64");
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

	test("rejects ARM-only binaries in Intel releases and Intel-only binaries in ARM releases", () => {
		const arm = inspectMachODeploymentTargets(makeThinMachO({ version: [14, 0] }));
		const intel = inspectMachODeploymentTargets(makeThinMachO({ version: [14, 0], cpuType: CPU_TYPE_X86_64 }));
		expect(() => assertMachOArchitecture(arm, "x64")).toThrow("requires x86_64 Mach-O slice; found arm64");
		expect(() => assertMachOArchitecture(intel, "arm64")).toThrow("requires arm64 Mach-O slice; found x86_64");
		expect(() => assertMachOArchitecture(intel, "x64")).not.toThrow();
	});

	test("accepts a universal binary containing the requested architecture", () => {
		const inspections = inspectMachODeploymentTargets(makeUniversalMachO([
			makeThinMachO({ version: [14, 0] }),
			makeThinMachO({ version: [14, 0], cpuType: CPU_TYPE_X86_64 }),
		]));
		for (const arch of ["x64", "arm64"]) {
			expect(() => assertMachOArchitecture(inspections, arch)).not.toThrow();
		}
	});

	test("release validation catches a wrong-architecture nested framework", () => {
		const directory = mkdtempSync(join(tmpdir(), "electrobun-macho-release-"));
		try {
			const framework = join(directory, "cef", "Chromium Embedded Framework.framework");
			mkdirSync(framework, { recursive: true });
			writeFileSync(join(directory, "launcher"), makeThinMachO({ version: [14, 0], cpuType: CPU_TYPE_X86_64 }));
			writeFileSync(join(directory, "native-devkit.json"), "{}");
			writeFileSync(join(framework, "Chromium Embedded Framework"), makeThinMachO({ version: [14, 0] }));
			expect(() => verifyMachORelease([directory], MACOS_DEPLOYMENT_TARGET, "x64")).toThrow("requires x86_64 Mach-O slice; found arm64");
			writeFileSync(join(framework, "Chromium Embedded Framework"), makeThinMachO({ version: [14, 0], cpuType: CPU_TYPE_X86_64 }));
			expect(verifyMachORelease([directory], MACOS_DEPLOYMENT_TARGET, "x64")).toHaveLength(2);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
