// Flatten the laid-out tree into the instanced-quad command buffer:
// 12 floats per instance — rect(x,y,w,h), color(r,g,b,a), misc(radius,0,0,0).
// Boxes, borders, and glyph runs all become colored rectangles. Instances
// draw in buffer order, so parents are emitted before children (painter's
// algorithm). Pure — testable without a GPU.

import { NodeKind, Prop, type UiTree } from "./tree";
import { GLYPH_ADVANCE, GLYPH_H, glyphRuns } from "./font";
import { atlasEntry, isNativeTextActive } from "./text";

export const FLOATS_PER_INSTANCE = 20;

// "No clip" sentinel large enough to cover any window.
const OPEN_CLIP: Clip = { x: -1e7, y: -1e7, w: 2e7, h: 2e7 };

interface Clip {
	x: number;
	y: number;
	w: number;
	h: number;
}

function intersectClip(a: Clip, b: Clip): Clip {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	return {
		x,
		y,
		w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x),
		h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y),
	};
}

export interface PaintBuffer {
	data: Float32Array;
	count: number;
}

export function parseColor(color: string | number): number {
	if (typeof color === "number") return color >>> 0;
	let hex = color.trim();
	if (hex.startsWith("#")) hex = hex.slice(1);
	if (hex.length === 3) {
		hex = hex
			.split("")
			.map((c) => c + c)
			.join("");
	}
	if (hex.length === 6) hex += "ff";
	if (hex.length !== 8) throw new Error(`Unsupported color: ${color}`);
	return Number.parseInt(hex, 16) >>> 0;
}

class InstanceWriter {
	data = new Float32Array(256 * FLOATS_PER_INSTANCE);
	count = 0;

	emit(
		x: number,
		y: number,
		w: number,
		h: number,
		rgba: number,
		radius: number,
		clip: Clip,
		uv?: { u0: number; v0: number; u1: number; v1: number },
	): void {
		const a = (rgba & 0xff) / 255;
		if (a === 0 || w <= 0 || h <= 0 || clip.w <= 0 || clip.h <= 0) return;
		// Fully outside the clip: skip the instance entirely.
		if (
			x >= clip.x + clip.w ||
			y >= clip.y + clip.h ||
			x + w <= clip.x ||
			y + h <= clip.y
		) {
			return;
		}
		if ((this.count + 1) * FLOATS_PER_INSTANCE > this.data.length) {
			const grown = new Float32Array(this.data.length * 2);
			grown.set(this.data);
			this.data = grown;
		}
		const o = this.count * FLOATS_PER_INSTANCE;
		this.data[o] = x;
		this.data[o + 1] = y;
		this.data[o + 2] = w;
		this.data[o + 3] = h;
		this.data[o + 4] = ((rgba >>> 24) & 0xff) / 255;
		this.data[o + 5] = ((rgba >>> 16) & 0xff) / 255;
		this.data[o + 6] = ((rgba >>> 8) & 0xff) / 255;
		this.data[o + 7] = a;
		this.data[o + 8] = radius;
		this.data[o + 9] = uv ? 1 : 0; // textured flag
		this.data[o + 10] = 0;
		this.data[o + 11] = 0;
		this.data[o + 12] = clip.x;
		this.data[o + 13] = clip.y;
		this.data[o + 14] = clip.w;
		this.data[o + 15] = clip.h;
		this.data[o + 16] = uv ? uv.u0 : 0;
		this.data[o + 17] = uv ? uv.v0 : 0;
		this.data[o + 18] = uv ? uv.u1 : 0;
		this.data[o + 19] = uv ? uv.v1 : 0;
		this.count++;
	}
}

function paintText(
	writer: InstanceWriter,
	tree: UiTree,
	id: number,
	clip: Clip,
): void {
	const node = tree.get(id);
	const size = node.props[Prop.FontSize]!;
	const color = node.props[Prop.TextColor]! >>> 0;

	// Native backend: one textured quad sampled from the glyph atlas.
	if (isNativeTextActive()) {
		const entry = atlasEntry(node.text, size);
		if (entry) {
			writer.emit(node.x, node.y, entry.w, entry.h, color, 0, clip, entry);
		}
		return;
	}

	// Bitmap fallback: glyph runs as rects.
	const cell = size / GLYPH_H;
	let penX = node.x;
	for (const char of node.text) {
		for (const [row, col, len] of glyphRuns(char)) {
			writer.emit(
				penX + col * cell,
				node.y + row * cell,
				len * cell,
				cell,
				color,
				0,
				clip,
			);
		}
		penX += GLYPH_ADVANCE * cell;
	}
}

function paintNode(
	writer: InstanceWriter,
	tree: UiTree,
	id: number,
	clip: Clip,
): void {
	const node = tree.get(id);

	if (node.kind === NodeKind.Text) {
		paintText(writer, tree, id, clip);
	} else if (node.kind === NodeKind.Box) {
		const bg = node.props[Prop.Bg]! >>> 0;
		const radius = node.props[Prop.Radius]!;
		const borderWidth = node.props[Prop.BorderWidth]!;
		const borderColor = node.props[Prop.BorderColor]! >>> 0;

		if (borderWidth > 0 && (borderColor & 0xff) !== 0) {
			writer.emit(node.x, node.y, node.w, node.h, borderColor, radius, clip);
			writer.emit(
				node.x + borderWidth,
				node.y + borderWidth,
				node.w - borderWidth * 2,
				node.h - borderWidth * 2,
				bg,
				Math.max(0, radius - borderWidth),
				clip,
			);
		} else {
			writer.emit(node.x, node.y, node.w, node.h, bg, radius, clip);
		}
	}
	// Anchor nodes paint nothing: they only reserve layout space for a
	// native layer composited by nativeWrapper.

	// Scroll containers clip their children to their own rect.
	const childClip =
		node.props[Prop.Overflow]! === 1
			? intersectClip(clip, { x: node.x, y: node.y, w: node.w, h: node.h })
			: clip;

	for (let c = node.first; c !== 0; c = tree.get(c).next) {
		paintNode(writer, tree, c, childClip);
	}
}

export function paint(tree: UiTree): PaintBuffer {
	const writer = new InstanceWriter();
	paintNode(writer, tree, tree.root, OPEN_CLIP);
	return { data: writer.data, count: writer.count };
}
