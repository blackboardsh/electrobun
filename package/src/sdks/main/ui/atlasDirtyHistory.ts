export interface AtlasDirtyRect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

export interface AtlasDirtySnapshot {
	revision: number;
	region: AtlasDirtyRect;
}

interface AtlasDirtyChange extends AtlasDirtySnapshot {}

function mergeRect(target: AtlasDirtyRect, next: AtlasDirtyRect): void {
	target.x0 = Math.min(target.x0, next.x0);
	target.y0 = Math.min(target.y0, next.y0);
	target.x1 = Math.max(target.x1, next.x1);
	target.y1 = Math.max(target.y1, next.y1);
}

/**
 * Non-destructive, bounded atlas change history. Each renderer keeps its own
 * acknowledged revision; lagging consumers fall back to one full upload.
 */
export class AtlasDirtyHistory {
	revision = 0;
	private readonly changes: AtlasDirtyChange[] = [];

	constructor(
		private readonly fullRegion: AtlasDirtyRect,
		private readonly maxChanges = 256,
	) {
		if (maxChanges < 1) throw new Error("Atlas dirty history must retain a change");
	}

	mark(region: AtlasDirtyRect): number {
		const revision = ++this.revision;
		this.changes.push({ revision, region: { ...region } });
		if (this.changes.length > this.maxChanges) this.changes.shift();
		return revision;
	}

	snapshotSince(acknowledgedRevision: number): AtlasDirtySnapshot | null {
		if (acknowledgedRevision >= this.revision) return null;
		const oldest = this.changes[0];
		if (!oldest || acknowledgedRevision < oldest.revision - 1) {
			return { revision: this.revision, region: { ...this.fullRegion } };
		}

		let region: AtlasDirtyRect | null = null;
		for (const change of this.changes) {
			if (change.revision <= acknowledgedRevision) continue;
			if (!region) region = { ...change.region };
			else mergeRect(region, change.region);
		}
		return region ? { revision: this.revision, region } : null;
	}
}
