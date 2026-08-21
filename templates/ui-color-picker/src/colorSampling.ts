export function packRgbaPixels(rgba: Uint8Array): Uint32Array {
	if (rgba.byteLength % 4 !== 0) {
		throw new RangeError("RGBA pixel data length must be divisible by four");
	}

	const packed = new Uint32Array(rgba.byteLength / 4);
	for (let i = 0; i < packed.length; i++) {
		const offset = i * 4;
		packed[i] =
			((rgba[offset]! << 24) |
				(rgba[offset + 1]! << 16) |
				(rgba[offset + 2]! << 8) |
				rgba[offset + 3]!) >>>
			0;
	}
	return packed;
}

export function packedPixelsEqual(
	left: Uint32Array,
	right: Uint32Array,
): boolean {
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		if (left[i] !== right[i]) return false;
	}
	return true;
}
