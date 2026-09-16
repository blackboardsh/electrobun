import type { AnchorRect, UiContext } from "./ui";

export interface PointLike {
	x: number;
	y: number;
}

/** Translate a screen-space pointer into coordinates local to a render view. */
export function pointerToViewLocal(
	screenPoint: PointLike,
	windowContentOrigin: PointLike,
	viewOffset: PointLike,
): PointLike {
	return {
		x: screenPoint.x - windowContentOrigin.x - viewOffset.x,
		y: screenPoint.y - windowContentOrigin.y - viewOffset.y,
	};
}

/** Rectangles where a GTK native webview must show through the WGPU layer. */
export function collectWebviewAnchorMasks(ctx: UiContext): AnchorRect[] {
	const masks: AnchorRect[] = [];
	for (const id of ctx.webviewAnchors) {
		if (!ctx.tree.has(id)) continue;
		const node = ctx.tree.get(id);
		if (node.w <= 0 || node.h <= 0) continue;
		masks.push({
			x: node.x,
			y: node.y,
			width: node.w,
			height: node.h,
		});
	}
	return masks;
}
