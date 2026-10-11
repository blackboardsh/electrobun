// Native --check-runtime reserves 42 for a missing WebView2 runtime. Other
// failures must not silently become permission to install software.
export async function ensureWebview2Runtime({ probe, install, allowInstall = false }) {
  let result = await probe();
  if (result.status === 0) return { installed: false, version: result.output.trim() };
  if (result.status !== 42) throw new Error(`WebView2 runtime probe failed (${result.status}): ${result.output}`);
  if (!allowInstall) throw new Error("WebView2 runtime is missing. Install it explicitly or use --install-missing-runtime on a disposable CI runner.");
  await install();
  result = await probe();
  if (result.status !== 0) throw new Error(`WebView2 runtime still unavailable after installer success (${result.status}): ${result.output}`);
  return { installed: true, version: result.output.trim() };
}

export function assertMicrosoftSignature(signature) {
  if (signature?.status !== "Valid" || typeof signature.subject !== "string" ||
      !/(?:^|,\s*)O=Microsoft Corporation(?:,|$)/.test(signature.subject)) {
    throw new Error("WebView2 bootstrapper must have a valid Microsoft Authenticode signature");
  }
}

// Dependencies are injected so install/error decisions can be tested without
// downloading or installing anything. The real caller supplies bounded native
// subprocesses; all phases share one five-minute budget.
export async function installWebview2Runtime({ installerPath, download, readSignature, execute, now = Date.now }) {
  const deadline = now() + 300_000;
  const budget = (maximum) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("WebView2 runtime provisioning exceeded five minutes");
    return Math.min(maximum, remaining);
  };
  await download(installerPath, budget(60_000));
  assertMicrosoftSignature(await readSignature(installerPath, budget(30_000)));
  const result = await execute(installerPath, ["/silent", "/install"], budget(240_000));
  if (result.status !== 0) throw new Error(`WebView2 runtime installer failed (${result.status}): ${result.output}`);
  budget(1); // A timed-out helper cannot report success after the deadline.
}
