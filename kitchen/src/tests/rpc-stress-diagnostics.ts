// Failure reporting reads existing JS state only: no additional RPC traffic,
// native calls, or waiting for events that might themselves be stalled.
export function reportRpcStressFailure(
  snapshot: () => unknown,
  log: (message: string) => void,
): void {
  try {
    log(`RPC burst failure diagnostics: ${JSON.stringify(snapshot()).slice(0, 4000)}`);
  } catch (error) {
    try {
      log(`RPC burst diagnostics unavailable: ${String(error).slice(0, 300)}`);
    } catch {
      // Even an unavailable logger must preserve the original test failure.
    }
  }
}
