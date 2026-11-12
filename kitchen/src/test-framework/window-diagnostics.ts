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
