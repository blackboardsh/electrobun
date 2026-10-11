import {
  parseWebview2InitializationState,
  type NativeRect,
  type Webview2InitializationState,
} from "./webview2-initialization-state";

export type Pixel = { r: number; g: number; b: number };
export type Webview2StackingState = Webview2InitializationState & {
  childHwnd: string | null;
  childParentHwnd: string | null;
  childOwned: boolean;
  childVisible: boolean | null;
  childExStyle: number | null;
  childSiblingIndex: number | null;
  screenPixel: Pixel | null;
};

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`WebView2 stacking regression: ${message}`);
}

export function parseWebview2StackingState(json: string): Webview2StackingState {
  const state = parseWebview2InitializationState(json) as Webview2StackingState;
  for (const key of ["childHwnd", "childParentHwnd"] as const) {
    check(state[key] === null || (typeof state[key] === "string" && /^0x[\da-f]+$/i.test(state[key])), `invalid ${key}`);
  }
  check(typeof state.childOwned === "boolean", "missing controller ownership proof");
  check(state.childVisible === null || typeof state.childVisible === "boolean", "invalid child visibility");
  for (const key of ["childExStyle", "childSiblingIndex"] as const) {
    check(state[key] === null || (Number.isSafeInteger(state[key]) && state[key]! >= 0), `invalid ${key}`);
  }
  check(state.screenPixel === null || (typeof state.screenPixel === "object" &&
    ["r", "g", "b"].every((key) => Number.isInteger(state.screenPixel?.[key as keyof Pixel]) &&
      state.screenPixel![key as keyof Pixel] >= 0 && state.screenPixel![key as keyof Pixel] <= 255)),
  "invalid desktop pixel");
  return state;
}

export function assertOwnedWebview2Children(states: Webview2StackingState[]) {
  check(states.length >= 2, "ownership requires at least two controllers");
  const handles = new Set<string>();
  const parent = states[0]!.childParentHwnd;
  for (const state of states) {
    check(state.ready && state.controllerPresent && !state.removed, "controller is not live");
    check(state.childOwned && state.childHwnd !== null && state.childHwnd !== "0x0", "controller HWND is not owned");
    check(state.childParentHwnd !== null && state.childParentHwnd !== "0x0" && state.childParentHwnd === parent,
      "controller HWND has the wrong parent");
    check(!handles.has(state.childHwnd), "controllers alias the same HWND");
    handles.add(state.childHwnd);
    check(state.childSiblingIndex !== null && state.childExStyle !== null, "missing native window observation");
  }
}

export function assertPresentedWebview2Child(
  child: Webview2StackingState,
  host: Webview2StackingState,
  expected: NativeRect,
  color: Pixel,
  originalHostStyle: number,
) {
  assertOwnedWebview2Children([host, child]);
  check(child.bounds !== null && ["x", "y", "width", "height"].every((key) =>
    child.bounds![key as keyof NativeRect] === expected[key as keyof NativeRect]), "controller bounds are stale");
  check(child.visible === true && child.childVisible === true && !child.desiredTransparent,
    "guest controller or child HWND is hidden");
  check(!child.passthrough && !child.desiredPassthrough && (child.childExStyle! & 0x20) === 0,
    "guest input remains transparent");
  check(host.childExStyle === originalHostStyle, "guest operation changed host input style");
  check(child.childSiblingIndex! < host.childSiblingIndex!, "guest is stacked behind host");
  check(child.screenPixel !== null && ["r", "g", "b"].every((key) =>
    Math.abs(child.screenPixel![key as keyof Pixel] - color[key as keyof Pixel]) <= 3),
  `desktop guest pixel does not match: ${JSON.stringify(child.screenPixel)}`);
}
