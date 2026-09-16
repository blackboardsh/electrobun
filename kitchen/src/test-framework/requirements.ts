import type {
  TestDefinition,
  WindowRenderer,
} from "./types";

export function getTestSkipReason(
  test: TestDefinition,
  availableRenderers: readonly WindowRenderer[],
  platform: string = process.platform,
): string | undefined {
  if (test.requires?.platform && test.requires.platform !== platform) {
    return `requires ${test.requires.platform}, running on ${platform}`;
  }
  const requiredRenderer = test.requires?.renderer;
  if (!requiredRenderer || availableRenderers.includes(requiredRenderer)) {
    return undefined;
  }

  return `requires the ${requiredRenderer.toUpperCase()} renderer, but this build only includes ${availableRenderers.join(", ") || "no renderers"}`;
}
