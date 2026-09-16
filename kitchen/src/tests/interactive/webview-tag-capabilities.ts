export type WebviewTagPlaygroundCapabilities = {
  renderer: "cef" | "native";
  masks: boolean;
  passthrough: boolean;
};

export function resolveWebviewTagPlaygroundCapabilities(
  platform: NodeJS.Platform,
  availableRenderers: readonly string[],
): WebviewTagPlaygroundCapabilities {
  const renderer = availableRenderers.includes("cef") ? "cef" : "native";

  if (renderer === "cef") {
    return { renderer, masks: true, passthrough: true };
  }

  return {
    renderer,
    masks: platform === "darwin",
    passthrough: platform !== "win32",
  };
}
