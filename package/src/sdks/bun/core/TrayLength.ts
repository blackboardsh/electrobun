const appKitSquareLength = -2;

export function resolveTrayLength(
	length?: number | "square",
): number | undefined {
	if (length === undefined) return undefined;
	if (length === "square") return appKitSquareLength;
	if (!Number.isFinite(length) || length <= 0) {
		throw new RangeError("Tray length must be a positive number or 'square'");
	}
	return length;
}
