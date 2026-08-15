// Text backend for the UI runtime. Two implementations behind one interface:
//
// - bitmap (default): the built-in 5x7 font, pure — used in headless tests
//   and wherever the native wrapper lacks the CoreText exports.
// - native: system-font measurement + rasterization into a shared glyph
//   atlas, activated by mounts via tryEnableNativeText().
//
// Paint consults the backend for measurement and (in native mode) atlas
// entries; the renderer uploads dirty atlas regions and samples them for
// textured instances.

import { measureText as measureBitmap } from "./font";
import {
	AtlasDirtyHistory,
	type AtlasDirtySnapshot,
} from "./atlasDirtyHistory";

export interface AtlasEntry {
	// Normalized UV rect in the atlas.
	u0: number;
	v0: number;
	u1: number;
	v1: number;
	// Logical size of the rasterized string in points.
	w: number;
	h: number;
}

export const ATLAS_SIZE = 2048;
/** Device pixels per point used when rasterizing (crisp on 2x displays). */
export const ATLAS_SCALE = 2;

interface NativeTextApi {
	measure(
		text: string,
		fontName: string,
		size: number,
	): { w: number; h: number; ascent: number };
	rasterize(
		text: string,
		fontName: string,
		size: number,
		scale: number,
	): { width: number; height: number; data: Uint8Array } | null;
}

let nativeApi: NativeTextApi | null = null;
const measureCache = new Map<string, { w: number; h: number }>();

// ---------------------------------------------------------------------------
// Atlas: shelf packer over a CPU-side RGBA buffer. On overflow, the whole
// atlas resets (generation bump) and visible strings re-enter on next paint.
// ---------------------------------------------------------------------------

class TextAtlas {
	pixels = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
	entries = new Map<string, AtlasEntry>();
	generation = 0;
	private shelfX = 0;
	private shelfY = 0;
	private shelfHeight = 0;
	private readonly dirtyHistory = new AtlasDirtyHistory({
		x0: 0,
		y0: 0,
		x1: ATLAS_SIZE,
		y1: ATLAS_SIZE,
	});

	get revision(): number {
		return this.dirtyHistory.revision;
	}

	dirtySince(revision: number): AtlasDirtySnapshot | null {
		return this.dirtyHistory.snapshotSince(revision);
	}

	private markDirty(x: number, y: number, w: number, h: number) {
		this.dirtyHistory.mark({ x0: x, y0: y, x1: x + w, y1: y + h });
	}

	private reset() {
		this.entries.clear();
		this.pixels.fill(0);
		this.shelfX = 0;
		this.shelfY = 0;
		this.shelfHeight = 0;
		this.generation++;
		this.markDirty(0, 0, ATLAS_SIZE, ATLAS_SIZE);
	}

	get(key: string, text: string, size: number): AtlasEntry | null {
		const existing = this.entries.get(key);
		if (existing) return existing;
		if (!nativeApi) return null;
		const raster = nativeApi.rasterize(text, "", size, ATLAS_SCALE);
		if (!raster || raster.width === 0) return null;
		const pad = 1; // guard against sampling bleed
		const w = raster.width + pad * 2;
		const h = raster.height + pad * 2;
		if (w > ATLAS_SIZE || h > ATLAS_SIZE) return null;

		if (this.shelfX + w > ATLAS_SIZE) {
			this.shelfY += this.shelfHeight;
			this.shelfX = 0;
			this.shelfHeight = 0;
		}
		if (this.shelfY + h > ATLAS_SIZE) {
			this.reset();
		}
		const x = this.shelfX + pad;
		const y = this.shelfY + pad;
		this.shelfX += w;
		this.shelfHeight = Math.max(this.shelfHeight, h);

		// Blit the rasterized rows into the atlas buffer.
		for (let row = 0; row < raster.height; row++) {
			const src = row * raster.width * 4;
			const dst = ((y + row) * ATLAS_SIZE + x) * 4;
			this.pixels.set(raster.data.subarray(src, src + raster.width * 4), dst);
		}
		this.markDirty(x - pad, y - pad, w, h);

		const measured = measure(text, size);
		const entry: AtlasEntry = {
			u0: x / ATLAS_SIZE,
			v0: y / ATLAS_SIZE,
			u1: (x + raster.width) / ATLAS_SIZE,
			v1: (y + raster.height) / ATLAS_SIZE,
			w: measured.w,
			h: measured.h,
		};
		this.entries.set(key, entry);
		return entry;
	}
}

export const textAtlas = new TextAtlas();

// ---------------------------------------------------------------------------
// Public backend surface
// ---------------------------------------------------------------------------

/** Switch to the native (system font) backend. Returns whether it's active. */
export function tryEnableNativeText(api: NativeTextApi | null): boolean {
	if (nativeApi) return true;
	if (!api) return false;
	nativeApi = api;
	measureCache.clear();
	return true;
}

export function isNativeTextActive(): boolean {
	return nativeApi !== null;
}

/** Force the pure bitmap backend (tests). */
export function resetTextBackend(): void {
	nativeApi = null;
	measureCache.clear();
}

export function measure(text: string, size: number): { w: number; h: number } {
	if (!nativeApi) return measureBitmap(text, size);
	const key = `${size}|${text}`;
	const cached = measureCache.get(key);
	if (cached) return cached;
	const m = nativeApi.measure(text, "", size);
	const result = { w: m.w, h: m.h };
	if (measureCache.size > 10_000) measureCache.clear();
	measureCache.set(key, result);
	return result;
}

/** Atlas entry for a string (native backend only). */
export function atlasEntry(text: string, size: number): AtlasEntry | null {
	if (!nativeApi || text.length === 0) return null;
	return textAtlas.get(`${size}|${text}`, text, size);
}
