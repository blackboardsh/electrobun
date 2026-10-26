/** Keep layout/input in points and round only the drawable extent. */
export function physicalSize(width: number, height: number, pixelRatio: number) {
	if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) {
		throw new RangeError("pixelRatio must be positive and finite");
	}
	return {
		width: Math.max(1, Math.round(width * pixelRatio)),
		height: Math.max(1, Math.round(height * pixelRatio)),
	};
}

type Rect = { x: number; y: number; width: number; height: number };

export function pixelRatioForFrame(
	frame: Rect,
	displays: readonly { bounds: Rect; scaleFactor: number }[],
	fallback = 1,
): number {
	let area = 0;
	let ratio = fallback;
	for (const display of displays) {
		const bounds = display.bounds;
		const width = Math.max(
			0,
			Math.min(frame.x + frame.width, bounds.x + bounds.width) -
				Math.max(frame.x, bounds.x),
		);
		const height = Math.max(
			0,
			Math.min(frame.y + frame.height, bounds.y + bounds.height) -
				Math.max(frame.y, bounds.y),
		);
		const overlap = width * height;
		if (overlap > area) {
			area = overlap;
			ratio = display.scaleFactor;
		}
	}
	return ratio;
}
