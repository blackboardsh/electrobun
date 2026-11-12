type WindowPhase = {
  operation: string;
  startedAt: number;
  windowId?: number;
  testId?: string;
};

// Direct stderr avoids mirroring diagnostic messages into the renderer. These
// markers observe existing calls only: no extra native reads, waits, or timers.
export function startWindowPhase(operation: string, windowId?: number, testId?: string): WindowPhase | undefined {
  if (process.env["ELECTROBUN_DEBUG_FULLSCREEN"] !== "1") return undefined;
  const startedAt = performance.now();
  const phase = { operation, startedAt, windowId, testId };
  console.error(`[kitchen window phase] ${JSON.stringify({
    at: new Date().toISOString(), phase: "start", operation, windowId, testId,
    tMs: Math.round(startedAt),
  })}`);
  return phase;
}

export function finishWindowPhase(phase: WindowPhase | undefined, windowId = phase?.windowId): void {
  if (!phase) return;
  const finishedAt = performance.now();
  console.error(`[kitchen window phase] ${JSON.stringify({
    at: new Date().toISOString(), phase: "end", operation: phase.operation,
    windowId, testId: phase.testId, tMs: Math.round(finishedAt),
    elapsedMs: Math.round(finishedAt - phase.startedAt),
  })}`);
}

type WindowSnapshotReaders<Frame, WorkArea> = {
  isFullScreen: () => boolean;
  getFrame: () => Frame;
  getPrimaryDisplay: () => WorkArea;
};

// Preserve the sequential native reads: a slow field can otherwise make the
// snapshot combine fullscreen state and geometry from different moments.
export function readWindowSnapshot<Frame, WorkArea>(
  readers: WindowSnapshotReaders<Frame, WorkArea>,
  windowId?: number,
): { fullscreen: boolean; frame: Frame; workArea: WorkArea } {
  const enabled = windowId !== undefined && process.env["ELECTROBUN_DEBUG_FULLSCREEN"] === "1";
  const startedAt = enabled ? performance.now() : 0;
  const fieldElapsedMs: Record<string, number> = {};
  function read<T>(field: keyof WindowSnapshotReaders<Frame, WorkArea>, operation: () => T): T {
    if (!enabled) return operation();
    const started = performance.now();
    const value = operation();
    fieldElapsedMs[field] = Math.round(performance.now() - started);
    return value;
  }

  const snapshot = {
    fullscreen: read("isFullScreen", readers.isFullScreen),
    frame: read("getFrame", readers.getFrame),
    workArea: read("getPrimaryDisplay", readers.getPrimaryDisplay),
  };
  if (enabled) {
    const finishedAt = performance.now();
    const elapsed = finishedAt - startedAt;
    if (elapsed > 100) {
      console.error(`[kitchen window phase] ${JSON.stringify({
        at: new Date().toISOString(), phase: "slow-snapshot",
        operation: "fullscreen.restorationSnapshot", windowId,
        startedTMs: Math.round(startedAt), tMs: Math.round(finishedAt),
        elapsedMs: Math.round(elapsed), fieldElapsedMs,
      })}`);
    }
  }
  return snapshot;
}
