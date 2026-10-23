import type { GPUDevice, GPURenderPassEncoder } from "../webgpuAdapter";
import type { Clip } from "./paint";

export interface UiTextRun {
	id: number;
	text: string;
	size: number;
	color: number;
	x: number;
	y: number;
}

export interface UiTextViewport {
	width: number;
	height: number;
	pixelWidth: number;
	pixelHeight: number;
}

/** Device and pass types come from Electrobun's partial native WebGPU adapter. */
export interface UiTextRenderer {
	measure(text: string, size: number): { w: number; h: number };
	/** Prepare uploads and retire resources for text absent from this frame. */
	prepare(runs: readonly UiTextRun[], viewport: UiTextViewport): void;
	/** Draw into the borrowed pass; do not retain it, end it, or submit it.
	 * Warren sets the viewport and clip before each draw. */
	draw(pass: GPURenderPassEncoder, run: UiTextRun): void;
	dispose(): void;
}

/** The device is borrowed; dispose only resources owned by this backend. */
export type UiTextRendererFactory = (context: {
	device: GPUDevice;
	format: string | number;
}) => UiTextRenderer | Promise<UiTextRenderer>;

/** Match the fragment-center clipping used by Warren's quad shader. */
export function textScissor(clip: Clip, viewport: UiTextViewport) {
	const sx = viewport.pixelWidth / viewport.width;
	const sy = viewport.pixelHeight / viewport.height;
	const x = Math.max(0, Math.min(viewport.pixelWidth, Math.ceil(clip.x * sx - 0.5)));
	const y = Math.max(0, Math.min(viewport.pixelHeight, Math.ceil(clip.y * sy - 0.5)));
	const right = Math.max(x, Math.min(viewport.pixelWidth, Math.ceil((clip.x + clip.w) * sx - 0.5)));
	const bottom = Math.max(y, Math.min(viewport.pixelHeight, Math.ceil((clip.y + clip.h) * sy - 0.5)));
	return { x, y, width: right - x, height: bottom - y };
}
