function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Navigation block regression: ${message}`);
}

function parseDetail(detail: unknown): unknown {
  if (typeof detail !== "string") return detail;
  try { return JSON.parse(detail); } catch { return detail; }
}

export function assertBlockedNavigation(
  existingUrl: string,
  blockedUrl: string,
  willNavigateDetails: unknown[],
  didNavigateDetails: unknown[],
) {
  const target = new URL(blockedUrl).href;
  let denied = false;
  for (const detail of willNavigateDetails) {
    const decision = parseDetail(detail) as { url?: unknown; allowed?: unknown } | null;
    check(decision !== null && typeof decision === "object" &&
      typeof decision.url === "string" && typeof decision.allowed === "boolean",
    `invalid navigation decision: ${JSON.stringify(detail)}`);
    if (new URL(decision.url).href !== target) continue;
    check(decision.allowed === false, `blocked target was allowed: ${decision.url}`);
    denied = true;
  }
  check(denied, `missing explicit denial for ${target}`);

  for (const detail of didNavigateDetails) {
    const event = parseDetail(detail);
    // WebView2 sends JSON {url}; the other backends send the URL directly.
    const url = typeof event === "string" ? event :
      event !== null && typeof event === "object" ? (event as { url?: unknown }).url : undefined;
    check(typeof url === "string", `invalid committed navigation: ${JSON.stringify(detail)}`);
    // Initial-page completion can arrive after listeners attach. Nothing else,
    // including a redirect or another views:// URL, is an acceptable commit.
    check(url === existingUrl, `unexpected committed navigation: ${url}`);
  }
}
