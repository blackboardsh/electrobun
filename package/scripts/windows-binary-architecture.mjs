import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function windowsBinaryArchitecture(path) {
	const file = openSync(path, "r");
	try {
		const dos = Buffer.alloc(64);
		if (readSync(file, dos, 0, dos.length, 0) !== dos.length || dos.readUInt16LE(0) !== 0x5a4d) {
			throw new Error(`Invalid Windows executable: ${path}`);
		}
		const pe = Buffer.alloc(6);
		const offset = dos.readUInt32LE(0x3c);
		if (offset < 64 || readSync(file, pe, 0, pe.length, offset) !== pe.length || pe.readUInt32LE(0) !== 0x4550) {
			throw new Error(`Invalid PE header: ${path}`);
		}
		const machine = pe.readUInt16LE(4);
		if (machine === 0x8664) return "x64";
		if (machine === 0xaa64) return "arm64";
		throw new Error(`Unsupported Windows machine 0x${machine.toString(16)}: ${path}`);
	} finally {
		closeSync(file);
	}
}

export function assertWindowsBinaryArchitecture(path, expected) {
	const actual = windowsBinaryArchitecture(path);
	if (actual !== expected) throw new Error(`Expected ${expected}, found ${actual}: ${path}`);
}

export function validateWindowsReleaseArchitecture(root, expected) {
	let count = 0;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) count += validateWindowsReleaseArchitecture(path, expected);
		else if (entry.isFile() && /\.(exe|dll)$/i.test(entry.name)) {
			assertWindowsBinaryArchitecture(path, expected);
			count += 1;
		}
	}
	return count;
}
