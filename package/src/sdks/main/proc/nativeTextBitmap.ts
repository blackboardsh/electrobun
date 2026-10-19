import { ptr, toArrayBuffer, type Pointer } from "bun:ffi";

export function rasterizeNativeText(
	symbols: {
		rasterizeText: (text: Pointer, font: Pointer, size: number, scale: number, width: Pointer, height: Pointer) => Pointer | null;
		freeTextBitmap: (pixels: Pointer) => void;
	},
	text: string,
	fontName: string,
	size: number,
	scale: number,
): { width: number; height: number; data: Uint8Array } | null {
	const textBytes = new TextEncoder().encode(`${text}\0`);
	const fontBytes = new TextEncoder().encode(`${fontName}\0`);
	// Keep independent output buffers: Bun's FFI can rematerialize a
	// shared backing store while evaluating ptr() on a subarray, leaving
	// the earlier width pointer disconnected from the JavaScript view.
	const widthOut = new Int32Array(1);
	const heightOut = new Int32Array(1);
	const pixelsPtr = symbols.rasterizeText(
		ptr(textBytes),
		ptr(fontBytes),
		size,
		scale,
		ptr(widthOut),
		ptr(heightOut),
	);
	if (!pixelsPtr) return null;
	const width = widthOut[0]!;
	const height = heightOut[0]!;
	try {
		// Copy before releasing the native bitmap. Bun 1.4's worker-side FFI
		// buffer does not consistently expose ArrayBuffer.prototype.slice.
		const pixels = new Uint8Array(
			toArrayBuffer(pixelsPtr as Pointer, 0, width * height * 4),
		);
		return { width, height, data: new Uint8Array(pixels) };
	} finally {
		symbols.freeTextBitmap(pixelsPtr);
	}
}
