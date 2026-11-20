import { expect, test } from "bun:test";
import { bufferSourceBytes } from "./webgpuBufferSource";

test("writeBuffer offsets use typed elements and respect a subview's offset", () => {
	const source = new Uint32Array([10, 20, 30, 40]);
	const selected = bufferSourceBytes(source.subarray(1), 1, 1);
	expect(new DataView(selected.buffer, selected.byteOffset, selected.byteLength).getUint32(0, true)).toBe(30);
	expect(selected.byteLength).toBe(4);
});

test("ArrayBuffer and DataView ranges use bytes and reject out-of-bounds sources", () => {
	const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
	expect(Array.from(bufferSourceBytes(source.buffer, 4))).toEqual([5, 6, 7, 8]);
	expect(Array.from(bufferSourceBytes(new DataView(source.buffer, 2, 4), 1, 2))).toEqual([4, 5]);
	expect(() => bufferSourceBytes(source, 7, 2)).toThrow(RangeError);
	expect(() => bufferSourceBytes(source, -1)).toThrow(RangeError);
});
