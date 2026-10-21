import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const marker = 'ELECTROBUN_BUNNY_DIAGNOSTICS';
const sha256 = text => createHash('sha256').update(text).digest('hex');

// This runs before the generated project's original renderer script. Its
// telemetry does not depend on Electroview initialization or application RPC.
function rendererProbe(endpoint) {
  const state = { rafRequested: 0, rafCompleted: 0, rpcReceived: 0, lastCursor: null, contexts: [] };
  let reports = 0;
  const report = (event, data = {}) => {
    if (++reports > 500) return;
    const payload = { source: 'renderer', event, timestamp: Date.now(), ...data };
    try { console.log('[bunny-diagnostics]', JSON.stringify(payload)); } catch {}
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload), keepalive: true, signal: controller.signal })
        .catch(() => {}).finally(() => clearTimeout(timeout));
    } catch {}
  };
  window.__bunnyDiagnostics = { state, report };
  addEventListener('error', event => report('error', {
    message: event.message || 'resource error', filename: event.filename,
    line: event.lineno, column: event.colno, stack: event.error?.stack,
    resource: event.target?.src || event.target?.href,
  }), true);
  addEventListener('unhandledrejection', event => report('unhandledrejection', {
    message: String(event.reason), stack: event.reason?.stack,
  }));
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(...args) {
    let context;
    try { context = Reflect.apply(getContext, this, args); }
    catch (error) {
      report('context-error', { type: args[0], message: String(error) });
      throw error;
    }
    const detail = { type: args[0], available: context !== null, options: args[1], className: this.className };
    if (context && /^webgl|experimental-webgl/.test(String(args[0]))) {
      try {
        detail.version = context.getParameter(context.VERSION);
        detail.renderer = context.getParameter(context.RENDERER);
        detail.vendor = context.getParameter(context.VENDOR);
        detail.lost = context.isContextLost();
      } catch (error) { detail.inspectionError = String(error); }
    }
    if (state.contexts.length < 50) state.contexts.push(detail);
    report('context', detail);
    return context;
  };
  const requestFrame = window.requestAnimationFrame;
  window.requestAnimationFrame = function(callback) {
    state.rafRequested++;
    return Reflect.apply(requestFrame, this, [function(...args) {
      state.rafCompleted++;
      return Reflect.apply(callback, this, args);
    }]);
  };
  const snapshot = () => {
    const bunny = document.getElementById('bunny');
    const canvas = document.querySelector('.spark-canvas');
    report('snapshot', {
      readyState: document.readyState, visibility: document.visibilityState,
      transform: bunny?.style.transform, computedTransform: bunny ? getComputedStyle(bunny).transform : null,
      rect: bunny ? bunny.getBoundingClientRect().toJSON() : null,
      canvas: canvas ? { width: canvas.width, height: canvas.height, display: canvas.style.display } : null,
      rafRequested: state.rafRequested, rafCompleted: state.rafCompleted,
      rpcReceived: state.rpcReceived, lastCursor: state.lastCursor,
      pendingHostMessages: window.__electrobunPendingHostMessages?.length,
      hostReceiver: window.__electrobun?.receiveMessageFromHost?.name,
      webviewId: window.__electrobunWebviewId,
      consoleForwarding: window.__electrobunConsoleForwardingInstalled === true,
    });
  };
  window.__bunnyDiagnostics.snapshot = snapshot;
  report('installed', { href: location.href, userAgent: navigator.userAgent });
  addEventListener('DOMContentLoaded', snapshot);
  let samples = 0;
  const timer = setInterval(() => {
    try { snapshot(); } catch (error) { report('snapshot-error', { message: String(error) }); }
    if (++samples >= 90) clearInterval(timer);
  }, 500);
}

function rendererRpcProbe() {
  return `// ${marker}: observe the original RPC handler without changing its result.
import { Electroview as __bunnyDiagnosticElectroview } from "electrobun/view";
const __bunnyDiagnosticDefineRPC = (__bunnyDiagnosticElectroview as any).defineRPC;
(__bunnyDiagnosticElectroview as any).defineRPC = function(config: any) {
  const original = config?.handlers?.messages?.cursorMove;
  if (typeof original === "function") {
    config.handlers.messages.cursorMove = function(...args: any[]) {
      const diagnostic = (window as any).__bunnyDiagnostics;
      if (diagnostic) {
        diagnostic.state.rpcReceived++;
        diagnostic.state.lastCursor = args[0];
      }
      return Reflect.apply(original, this, args);
    };
    (window as any).__bunnyDiagnostics?.report("rpc-registered");
  }
  return Reflect.apply(__bunnyDiagnosticDefineRPC, this, [config]);
};
`;
}

function hostProbe(endpoint) {
  return `// ${marker}: generated-project diagnostic sampling only.
import { BrowserView as __bunnyDiagnosticView, BrowserWindow as __bunnyDiagnosticWindow, Screen as __bunnyDiagnosticScreen } from "electrobun/main";
let __bunnyDiagnosticSamples = 0;
const __bunnyDiagnosticReport = (event: string, data: any) => {
  const payload = { source: "host", event, timestamp: Date.now(), ...data };
  console.log("[bunny-diagnostics]", JSON.stringify(payload));
  fetch(${JSON.stringify(endpoint)}, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(2000) }).catch(() => {});
};
const __bunnyDiagnosticTimer = setInterval(() => {
  try {
    const views = __bunnyDiagnosticView.getAll();
    __bunnyDiagnosticReport("snapshot", {
      cursor: __bunnyDiagnosticScreen.getCursorScreenPoint(),
      views: views.map(view => ({ id: view.id, renderer: view.renderer, windowId: view.windowId, frame: __bunnyDiagnosticWindow.getById(view.windowId)?.getFrame() })),
    });
    for (const view of views) view.executeJavascript("window.__bunnyDiagnostics?.snapshot()");
  } catch (error) { __bunnyDiagnosticReport("error", { message: String(error) }); }
  if (++__bunnyDiagnosticSamples >= 45) clearInterval(__bunnyDiagnosticTimer);
}, 1000);
__bunnyDiagnosticTimer.unref?.();
`;
}

export async function startBunnyDiagnostics({ project, output }) {
  const root = resolve(project);
  const paths = ['src/mainview/index.html', 'src/mainview/index.ts', 'src/bun/index.ts'].map(path => join(root, path));
  // Read and validate everything before starting the server or changing files.
  const originals = paths.map(path => readFileSync(path, 'utf8'));
  if (originals.some(text => text.includes(marker))) throw new Error('Bunny diagnostics already installed in this generated project');
  if (!/<head(?:\s[^>]*)?>/i.test(originals[0])) throw new Error('Bunny diagnostic HTML requires a head element');
  mkdirSync(output, { recursive: true });
  const logPath = resolve(output, 'bunny-diagnostics.jsonl');
  const metadataPath = resolve(output, 'bunny-diagnostics-metadata.json');
  const summary = { rendererStarted: false, received: 0, dropped: 0, eventCounts: {} };
  const route = `/bunny-diagnostics/${randomBytes(12).toString('hex')}`;
  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (request.url !== route) { response.writeHead(404).end(); return; }
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 65536) { response.writeHead(413).end(); request.destroy(); }
    });
    request.on('end', () => {
      if (response.writableEnded) return;
      try {
        const payload = JSON.parse(body);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Expected an event object');
        if (summary.received < 1000 || (payload.source === 'renderer' && payload.event === 'installed' && !summary.rendererStarted)) {
          appendFileSync(logPath, JSON.stringify({ receivedAt: new Date().toISOString(), payload }) + '\n');
        } else summary.dropped++;
        summary.received++;
        const eventKey = `${payload.source}:${payload.event}`;
        summary.eventCounts[eventKey] = (summary.eventCounts[eventKey] || 0) + 1;
        if (payload.source === 'renderer' && payload.event === 'installed') summary.rendererStarted = true;
        response.writeHead(204).end();
      } catch { response.writeHead(400).end(); }
    });
  });
  server.requestTimeout = 2000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const endpoint = `http://127.0.0.1:${server.address().port}${route}`;
  const script = `\n<script>/* ${marker} */\n(${rendererProbe.toString()})(${JSON.stringify(endpoint)});\n</script>\n`;
  const instrumented = [
    originals[0].replace(/<head(?:\s[^>]*)?>/i, match => match + script),
    rendererRpcProbe() + originals[1],
    hostProbe(endpoint) + originals[2],
  ];
  const metadata = {
    endpoint, logPath, project: root, startedAt: new Date().toISOString(), summary,
    sourceFiles: paths.map((path, index) => ({ path, originalSha256: sha256(originals[index]), instrumentedSha256: sha256(instrumented[index]) })),
  };
  try {
    paths.forEach((path, index) => writeFileSync(path, instrumented[index]));
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
    appendFileSync(logPath, JSON.stringify({ receivedAt: new Date().toISOString(), payload: { source: 'collector', event: 'started' } }) + '\n');
  } catch (error) {
    paths.forEach((path, index) => writeFileSync(path, originals[index]));
    server.closeAllConnections();
    server.close();
    throw error;
  }
  let closing;
  return { metadata, close: () => closing ??= new Promise((resolveClose, reject) => {
    server.close(error => {
      metadata.closedAt = new Date().toISOString();
      try { writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n'); }
      catch (writeError) { reject(writeError); return; }
      if (error) reject(error);
      else if (!summary.rendererStarted) reject(new Error('Bunny diagnostics received no renderer installed/start event; frontend telemetry was unavailable'));
      else resolveClose();
    });
    server.closeAllConnections();
  }) };
}
