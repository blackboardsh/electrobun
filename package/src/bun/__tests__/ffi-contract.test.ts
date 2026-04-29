// Contract tests for the bun:ffi APIs that electrobun depends on.
//
// Bun bumps don't usually break electrobun, but when they do, the breakage
// almost always lives in this surface — JSCallback marshaling, FFIType
// encoding, dlopen behavior. These tests are a tripwire: if a new Bun release
// breaks any of them, we want to know before cutting an electrobun release,
// not after a user reports a crash.
//
// Skipped on Windows for now since the bun-check workflow runs on Linux and
// the system library paths differ. If we add a Windows runner later, switch
// the libc path resolution to include msvcrt/ucrtbase.

import { describe, expect, it } from "bun:test";
import {
	CString,
	FFIType,
	JSCallback,
	dlopen,
	ptr,
	toArrayBuffer,
	type Pointer,
} from "bun:ffi";

const isUnix =
	process.platform === "darwin" || process.platform === "linux";

const libcPath =
	process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";

(isUnix ? describe : describe.skip)(
	"bun:ffi contract used by electrobun",
	() => {
		it("dlopen + FFIType.cstring + FFIType.u64 (strlen)", () => {
			const lib = dlopen(libcPath, {
				strlen: {
					args: [FFIType.cstring],
					returns: FFIType.u64,
				},
			});

			const len = lib.symbols.strlen(
				new TextEncoder().encode("hello\0"),
			);
			expect(Number(len)).toBe(5);

			lib.close();
		});

		it("ptr + toArrayBuffer round-trip", () => {
			const src = new Uint8Array([1, 2, 3, 4, 5]);
			const back = new Uint8Array(
				toArrayBuffer(ptr(src), 0, src.byteLength),
			);
			expect(Array.from(back)).toEqual([1, 2, 3, 4, 5]);
		});

		it("CString reads null-terminated bytes", () => {
			const buf = new Uint8Array([72, 105, 33, 0]); // "Hi!\0"
			const s = new CString(ptr(buf));
			expect(s.toString()).toBe("Hi!");
		});

		it("JSCallback: native invokes JS via function pointer (qsort)", () => {
			const lib = dlopen(libcPath, {
				qsort: {
					args: [
						FFIType.ptr,
						FFIType.u64,
						FFIType.u64,
						FFIType.function,
					],
					returns: FFIType.void,
				},
			});

			let comparisonCount = 0;
			const compare = new JSCallback(
				(aPtr: Pointer, bPtr: Pointer) => {
					comparisonCount++;
					const a = new Int32Array(toArrayBuffer(aPtr, 0, 4))[0]!;
					const b = new Int32Array(toArrayBuffer(bPtr, 0, 4))[0]!;
					return a - b;
				},
				{
					args: [FFIType.ptr, FFIType.ptr],
					returns: FFIType.i32,
				},
			);

			const arr = new Int32Array([5, 2, 8, 1, 3]);
			lib.symbols.qsort(
				ptr(arr),
				BigInt(arr.length),
				4n,
				compare.ptr,
			);

			expect(Array.from(arr)).toEqual([1, 2, 3, 5, 8]);
			expect(comparisonCount).toBeGreaterThan(0);

			compare.close();
			lib.close();
		});
	},
);
