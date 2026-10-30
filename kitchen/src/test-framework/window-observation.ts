type ObservationOptions = {
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
};

type WindowRect = { x: number; y: number; width: number; height: number };
export type FullscreenSnapshot = {
  fullscreen: boolean;
  frame: WindowRect;
  workArea: WindowRect;
};

// AppKit clears the fullscreen style bit before restoring its window and Space.
export function isFullscreenRestored(observed: FullscreenSnapshot, original: FullscreenSnapshot): boolean {
  const coordinates = ["x", "y", "width", "height"] as const;
  return !observed.fullscreen && coordinates.every((key) =>
    Number.isFinite(observed.frame[key]) && Number.isFinite(original.frame[key]) &&
    Math.abs(observed.frame[key] - original.frame[key]) <= 1 &&
    Number.isFinite(observed.workArea[key]) && observed.workArea[key] === original.workArea[key]);
}

// Observe an already submitted window change. Never reissue it: an ignored
// request must still fail, while intermediate window-manager frames may settle.
export async function waitForWindowObservation<T>(
  label: string,
  read: () => T | Promise<T>,
  matches: (value: T) => boolean,
  options: ObservationOptions = {},
): Promise<T> {
  const timeout = options.timeoutMs ?? 3000 * (process.platform === "win32" ? 3 : 1);
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  let first: string | undefined;
  while (true) {
    const value = await read();
    const elapsed = now() - started;
    const observed = JSON.stringify(value);
    first ??= observed;
    if (elapsed <= timeout && matches(value)) {
      options.log?.(`${label} completed after ${Math.round(elapsed)}ms: first=${first}, last=${observed}`);
      return value;
    }
    if (elapsed >= timeout) {
      throw new Error(`${label} timed out after ${Math.round(elapsed)}ms (limit ${timeout}ms): first=${first}, last=${observed}`);
    }
    await sleep(Math.min(25, timeout - elapsed));
  }
}
