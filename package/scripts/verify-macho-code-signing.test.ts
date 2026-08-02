import { describe, expect, test } from "bun:test";
import {
	assertMachOCodeSigningCapacity,
	inspectMachOCodeSigning,
	MIN_MACHO_HEADERPAD,
} from "./verify-macho-code-signing.js";

const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_X86_64 = 0x01000007;
const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;
const HEADER_SIZE = 32;
const SEGMENT_SIZE = 72;
const SECTION_SIZE = 80;

function makeMachO({
	headerpad,
	hasCodeSignature = false,
}: {
	headerpad: number;
	hasCodeSignature?: boolean;
}) {
	const segmentCommandSize = SEGMENT_SIZE + SECTION_SIZE;
	const signatureCommandSize = hasCodeSignature ? 16 : 0;
	const commandSize = segmentCommandSize + signatureCommandSize;
	const textOffset = HEADER_SIZE + commandSize + headerpad;
	const buffer = Buffer.alloc(textOffset + 32);

	buffer.writeUInt32LE(MH_MAGIC_64, 0);
	buffer.writeUInt32LE(CPU_TYPE_X86_64, 4);
	buffer.writeUInt32LE(hasCodeSignature ? 2 : 1, 16);
	buffer.writeUInt32LE(commandSize, 20);

	buffer.writeUInt32LE(LC_SEGMENT_64, HEADER_SIZE);
	buffer.writeUInt32LE(segmentCommandSize, HEADER_SIZE + 4);
	buffer.writeUInt32LE(1, HEADER_SIZE + 64);
	const section = HEADER_SIZE + SEGMENT_SIZE;
	buffer.writeBigUInt64LE(32n, section + 40);
	buffer.writeUInt32LE(textOffset, section + 48);

	if (hasCodeSignature) {
		const signature = HEADER_SIZE + segmentCommandSize;
		buffer.writeUInt32LE(LC_CODE_SIGNATURE, signature);
		buffer.writeUInt32LE(signatureCommandSize, signature + 4);
	}

	return buffer;
}

describe("Mach-O code-signing capacity", () => {
	test("detects the unsafe Intel layout reported in issue #485", () => {
		const result = inspectMachOCodeSigning(makeMachO({ headerpad: 8 }));

		expect(result.architecture).toBe("x86_64");
		expect(result.headerpad).toBe(8);
		expect(result.hasCodeSignature).toBe(false);
		expect(() => assertMachOCodeSigningCapacity(result)).toThrow(
			"8 bytes of header padding",
		);
	});

	test("detects the reserved linker header padding", () => {
		const result = inspectMachOCodeSigning(
			makeMachO({ headerpad: MIN_MACHO_HEADERPAD }),
		);

		expect(result.headerpad).toBe(MIN_MACHO_HEADERPAD);
		expect(result.hasCodeSignature).toBe(false);
		expect(() => assertMachOCodeSigningCapacity(result)).not.toThrow();
	});

	test("recognizes a pre-existing code-signature command", () => {
		const result = inspectMachOCodeSigning(
			makeMachO({ headerpad: 0, hasCodeSignature: true }),
		);

		expect(result.headerpad).toBe(0);
		expect(result.hasCodeSignature).toBe(true);
		expect(() => assertMachOCodeSigningCapacity(result)).not.toThrow();
	});
});
