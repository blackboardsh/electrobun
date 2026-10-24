export type Extent3D =
	| { width: number; height?: number; depthOrArrayLayers?: number }
	| readonly [number, number?, number?];

export function normalizeExtent3D(size: Extent3D): {
	width: number;
	height: number;
	depthOrArrayLayers: number;
} {
	if ("width" in size) {
		return {
			width: size.width,
			height: size.height ?? 1,
			depthOrArrayLayers: size.depthOrArrayLayers ?? 1,
		};
	}
	return {
		width: size[0],
		height: size[1] ?? 1,
		depthOrArrayLayers: size[2] ?? 1,
	};
}
