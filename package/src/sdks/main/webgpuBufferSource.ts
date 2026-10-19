/** WebGPU dataOffset/size use elements for typed arrays, bytes otherwise. */
export function bufferSourceBytes(
	data: ArrayBuffer | ArrayBufferView,
	dataOffset = 0,
	size?: number,
): Uint8Array {
	const elementSize =
		ArrayBuffer.isView(data) && "BYTES_PER_ELEMENT" in data
			? Number(data.BYTES_PER_ELEMENT)
			: 1;
	const offset = dataOffset * elementSize;
	const length = size === undefined ? data.byteLength - offset : size * elementSize;
	if (
		!Number.isSafeInteger(dataOffset) || dataOffset < 0 ||
		(size !== undefined && (!Number.isSafeInteger(size) || size < 0)) ||
		offset > data.byteLength || length > data.byteLength - offset
	) {
		throw new RangeError("writeBuffer source range is outside the supplied data");
	}
	return ArrayBuffer.isView(data)
		? new Uint8Array(data.buffer, data.byteOffset + offset, length)
		: new Uint8Array(data, offset, length);
}
