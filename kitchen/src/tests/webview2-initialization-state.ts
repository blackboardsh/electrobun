export type NativeRect = { x: number; y: number; width: number; height: number };

export type Webview2InitializationState = {
  held: boolean;
  ready: boolean;
  controllerPresent: boolean;
  removed?: boolean;
  visible: boolean | null;
  desiredTransparent: boolean;
  passthrough: boolean;
  desiredPassthrough: boolean;
  bounds: NativeRect | null;
  requestedBounds: NativeRect;
  maskJSON: string;
  resizeRequests: number;
  dpi: number;
};

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`WebView2 initialization regression: ${message}`);
}

function isRect(value: unknown): value is NativeRect {
  if (!value || typeof value !== "object") return false;
  return ["x", "y", "width", "height"].every((key) =>
    Number.isFinite((value as Record<string, unknown>)[key]),
  );
}

export function parseWebview2InitializationState(json: string): Webview2InitializationState {
  const state = JSON.parse(json);
  check(state && typeof state === "object", "native snapshot must be an object");
  for (const key of ["held", "ready", "controllerPresent", "desiredTransparent", "passthrough", "desiredPassthrough"]) {
    check(typeof state[key] === "boolean", `invalid native ${key}`);
  }
  check(state.removed === undefined || typeof state.removed === "boolean", "invalid removed flag");
  check(state.visible === null || typeof state.visible === "boolean", "invalid native visibility");
  check(state.bounds === null || isRect(state.bounds), "invalid actual controller bounds");
  check(isRect(state.requestedBounds), "invalid requested bounds");
  check(typeof state.maskJSON === "string", "invalid mask JSON");
  check(Number.isSafeInteger(state.resizeRequests) && state.resizeRequests >= 0,
    "missing native resize-request counter");
  check(Number.isFinite(state.dpi) && state.dpi > 0, "invalid native DPI");
  return state;
}

// Win32 converts each DIP edge, not width/height independently. All fixture
// coordinates are positive, where Math.round matches native std::lround.
export function physicalRect(rect: NativeRect, scale: number): NativeRect {
  check(Number.isFinite(scale) && scale > 0, "invalid native DPI scale");
  const x = Math.round(rect.x * scale);
  const y = Math.round(rect.y * scale);
  return {
    x, y,
    width: Math.round((rect.x + rect.width) * scale) - x,
    height: Math.round((rect.y + rect.height) * scale) - y,
  };
}

function sameRect(actual: NativeRect | null, expected: NativeRect) {
  return actual !== null && ["x", "y", "width", "height"].every(
    (key) => actual[key as keyof NativeRect] === expected[key as keyof NativeRect],
  );
}

export function assertHeldWebview2State(state: Webview2InitializationState, expected: NativeRect, masks: string) {
  check(state.held && !state.ready && !state.removed, "creation was not held before the updates");
  check(!state.controllerPresent && state.bounds === null && state.visible === null, "controller already exists during the held phase");
  check(sameRect(state.requestedBounds, expected), `latest pre-controller bounds lost: ${JSON.stringify(state)}`);
  check(!state.desiredTransparent && !state.desiredPassthrough && !state.passthrough, "latest pre-controller reveal state lost");
  check(state.resizeRequests > 0, "no native pre-controller resize was exercised");
  check(state.maskJSON === masks, "latest pre-controller mask state lost");
}

export function assertReadyWebview2State(
  state: Webview2InitializationState,
  held: Webview2InitializationState,
  expected: NativeRect,
) {
  check(state.ready && state.controllerPresent && !state.held && !state.removed, "controller did not become ready");
  check(state.resizeRequests === held.resizeRequests,
    "post-release resize could mask an initialization failure");
  check(sameRect(state.bounds, expected), `actual controller bounds are stale: ${JSON.stringify(state)}`);
  check(sameRect(state.requestedBounds, expected), "requested bounds changed after release");
  check(state.visible === true && !state.desiredTransparent && !state.desiredPassthrough && !state.passthrough,
    `actual controller did not preserve the latest reveal: ${JSON.stringify(state)}`);
  check(state.maskJSON === held.maskJSON, "latest mask state changed during controller initialization");
}
