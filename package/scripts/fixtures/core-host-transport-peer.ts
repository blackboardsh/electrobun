import { CString, dlopen, ptr } from "bun:ffi";
import { createInterface } from "node:readline";

// Runs in its own process, like each Desktop host. The test-only library adds
// registration for a synthetic webview; listener, AES, framing, and queue code
// are the real native core. No window or native UI wrapper is needed.
const library = dlopen(process.argv[2]!, {
  configureWebviewRuntime: { args: ["u32", "cstring", "cstring"], returns: "bool" },
  testInstallTransportWebview: { args: ["u32", "u8"], returns: "bool" },
  testHostTransportPort: { args: [], returns: "u32" },
  popNextQueuedHostMessage: { args: ["ptr"], returns: "ptr" },
  getHostTransportDebugJSON: { args: [], returns: "ptr" },
  freeCoreString: { args: ["ptr"], returns: "void" },
});
const core = library.symbols;
const emptyPreload = Buffer.from("\0");
const started = core.configureWebviewRuntime(Number(process.argv[4] || 0), ptr(emptyPreload), ptr(emptyPreload));
if (!started) {
  process.stdout.write(`${JSON.stringify({ started: false })}\n`);
  process.exit(0);
}
if (!core.testInstallTransportWebview(2, Number(process.argv[3]))) {
  throw new Error("Failed to register the test webview");
}
process.stdout.write(`${JSON.stringify({ started: true, port: core.testHostTransportPort() })}\n`);

for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === "stop") process.exit(0);
  if (command.type !== "drain") throw new Error("Unknown fixture command");
  const messages = [];
  const webviewId = new Uint32Array(1);
  while (true) {
    const payload = core.popNextQueuedHostMessage(ptr(webviewId));
    if (!payload) break;
    try {
      messages.push({ webviewId: webviewId[0], message: JSON.parse(new CString(payload).toString()) });
    } finally {
      core.freeCoreString(payload);
    }
  }
  const diagnostics = core.getHostTransportDebugJSON();
  try {
    const debug = diagnostics ? JSON.parse(new CString(diagnostics).toString()) : null;
    process.stdout.write(`${JSON.stringify({ id: command.id, messages, debug })}\n`);
  } finally {
    if (diagnostics) core.freeCoreString(diagnostics);
  }
}
process.exit(0);
