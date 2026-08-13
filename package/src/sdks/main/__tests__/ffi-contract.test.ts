// Contract tests for the bun:ffi compatibility APIs Electrobun depends on.
//
// Runtime changes can break JSCallback marshaling, FFIType encoding, or dlopen
// behavior. Keep these tests with Electrobun so Cottontail changes cannot
// silently break the native bridge.
//
// Skipped on Windows because the system library paths differ. To enable them,
// extend the libc path resolution to include msvcrt/ucrtbase.

import { describe, expect, it } from "bun:test";
import {
	CFunction,
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

		// Regression: a macOS tray icon click calls the tray JSCallback with an
		// EMPTY action string (nativeWrapper.mm, statusItemClicked:). Cottontail
		// used to back the resulting zero-length view with a NULL pointer, which
		// JSC reports as detached, so this threw
		// "TypeError: Buffer is already detached" and wedged the tray.
		it("CString reads an empty null-terminated string", () => {
			const buf = new Uint8Array([0, 65]); // "\0A"
			const s = new CString(ptr(buf));
			expect(s.toString()).toBe("");
			expect(s.length).toBe(0);
			expect(new Uint8Array(s.arrayBuffer).length).toBe(0);
		});

		it("JSCallback: cstring arg survives an empty string (tray click)", () => {
			const seen: string[] = [];
			const onAction = new JSCallback(
				(actionPtr: Pointer) => {
					seen.push(new CString(actionPtr).toString());
				},
				{ args: [FFIType.cstring], returns: FFIType.void },
			);

			const empty = new Uint8Array([0]);
			const filled = new TextEncoder().encode("open-settings\0");
			const invoke = CFunction({
				ptr: onAction.ptr!,
				args: [FFIType.cstring],
				returns: FFIType.void,
			}) as unknown as (pointer: ReturnType<typeof ptr>) => void;

			invoke(ptr(empty));
			invoke(ptr(filled));
			invoke(ptr(empty));

			expect(seen).toEqual(["", "open-settings", ""]);

			onAction.close();
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
