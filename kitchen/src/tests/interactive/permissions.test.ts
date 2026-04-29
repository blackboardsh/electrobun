// Interactive Permission Prompt Tests
//
// These tests host a tiny localhost page and load it in a window so the
// origin is NOT views://. That bypasses the auto-accept short-circuit in the
// native permission handler and lets us exercise the real prompt path.
//
// Two variants run the same page against different renderers:
//   - "cef"    → exercises CEF's describeCefPermissions() decoder path
//   - "native" → exercises WKWebView / WebView2 / WebKitGTK delegates
//
// Each button feature-detects its API; buttons whose API is missing in the
// active renderer are disabled so the operator can see at a glance what is
// actually testable in this build.

import { defineTest } from "../../test-framework/types";
import { BrowserWindow } from "electrobun/bun";

const PERMISSION_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Permission Prompt Test</title>
<style>
  body { font-family: -apple-system, sans-serif; padding: 20px; color: #222; }
  h1 { margin: 0 0 4px 0; font-size: 18px; }
  h2 { margin: 18px 0 4px 0; font-size: 11px; color: #555; text-transform: uppercase; letter-spacing: 0.5px; }
  p { margin: 0 0 10px 0; color: #555; font-size: 13px; }
  #renderer-info { color: #888; font-size: 11px; word-break: break-all; }
  button {
    display: block;
    width: 100%;
    margin: 4px 0;
    padding: 8px 12px;
    font-size: 13px;
    text-align: left;
    border: 1px solid #ccc;
    border-radius: 6px;
    background: #f7f7f7;
    cursor: pointer;
  }
  button:hover:not(:disabled) { background: #ececec; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button code { color: #888; font-size: 11px; }
  #log {
    margin-top: 14px;
    padding: 10px;
    background: #f0f0f0;
    border-radius: 6px;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    white-space: pre-wrap;
    max-height: 180px;
    overflow-y: auto;
  }
</style>
</head>
<body>
  <h1>Permission Prompt Test</h1>
  <p>Click an enabled button below. The Electrobun dialog should name the specific permission being requested. Disabled buttons indicate APIs unavailable in this renderer.</p>
  <p id="renderer-info"></p>

  <h2>Cross-renderer</h2>
  <button id="geo">Geolocation<br><code>navigator.geolocation.getCurrentPosition()</code></button>
  <button id="camera">Camera<br><code>navigator.mediaDevices.getUserMedia({video:true})</code></button>
  <button id="mic">Microphone<br><code>navigator.mediaDevices.getUserMedia({audio:true})</code></button>
  <button id="notify">Notifications<br><code>Notification.requestPermission()</code></button>

  <h2>Chromium-only</h2>
  <button id="midi">MIDI sysex<br><code>navigator.requestMIDIAccess({sysex:true})</code></button>
  <button id="idle">Idle detection<br><code>IdleDetector.requestPermission()</code></button>
  <button id="window-mgmt">Window management<br><code>window.getScreenDetails()</code></button>
  <button id="fonts">Local fonts<br><code>window.queryLocalFonts()</code></button>

  <h2>WebKit-leaning</h2>
  <button id="storage">Storage access<br><code>document.requestStorageAccess()</code></button>

  <div id="log">Click an enabled button above to begin.</div>

<script>
  const logEl = document.getElementById('log');
  function log(msg) { logEl.textContent = msg + '\\n' + logEl.textContent; }

  document.getElementById('renderer-info').textContent = 'UA: ' + navigator.userAgent;

  function setup(id, available, handler) {
    const btn = document.getElementById(id);
    if (!available) {
      btn.disabled = true;
      btn.title = 'API not available in this renderer';
      return;
    }
    btn.addEventListener('click', handler);
  }

  setup('geo',
    !!(navigator.geolocation && navigator.geolocation.getCurrentPosition),
    () => {
      log('Requesting geolocation...');
      navigator.geolocation.getCurrentPosition(
        (pos) => log('  → granted: ' + pos.coords.latitude.toFixed(2) + ', ' + pos.coords.longitude.toFixed(2)),
        (err) => log('  → denied/error: ' + err.message),
      );
    },
  );

  setup('camera',
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    async () => {
      log('Requesting camera...');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        log('  → granted: ' + (stream.getVideoTracks()[0]?.label || 'video track'));
        stream.getTracks().forEach((t) => t.stop());
      } catch (e) {
        log('  → denied/error: ' + (e && e.message || e));
      }
    },
  );

  setup('mic',
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    async () => {
      log('Requesting microphone...');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        log('  → granted: ' + (stream.getAudioTracks()[0]?.label || 'audio track'));
        stream.getTracks().forEach((t) => t.stop());
      } catch (e) {
        log('  → denied/error: ' + (e && e.message || e));
      }
    },
  );

  setup('notify',
    typeof Notification !== 'undefined' && typeof Notification.requestPermission === 'function',
    async () => {
      log('Requesting notifications...');
      try {
        const result = await Notification.requestPermission();
        log('  → result: ' + result);
      } catch (e) {
        log('  → error: ' + (e && e.message || e));
      }
    },
  );

  setup('midi',
    typeof navigator.requestMIDIAccess === 'function',
    async () => {
      log('Requesting MIDI sysex...');
      try {
        const access = await navigator.requestMIDIAccess({ sysex: true });
        log('  → granted: ' + access.constructor.name);
      } catch (e) {
        log('  → denied/error: ' + (e && e.message || e));
      }
    },
  );

  setup('idle',
    typeof IdleDetector !== 'undefined',
    async () => {
      log('Requesting idle detection...');
      try {
        const result = await IdleDetector.requestPermission();
        log('  → result: ' + result);
      } catch (e) {
        log('  → error: ' + (e && e.message || e));
      }
    },
  );

  setup('window-mgmt',
    typeof window.getScreenDetails === 'function',
    async () => {
      log('Requesting window management...');
      try {
        const details = await window.getScreenDetails();
        log('  → granted, screens: ' + details.screens.length);
      } catch (e) {
        log('  → denied/error: ' + (e && e.message || e));
      }
    },
  );

  setup('fonts',
    typeof window.queryLocalFonts === 'function',
    async () => {
      log('Requesting local fonts...');
      try {
        const fonts = await window.queryLocalFonts();
        log('  → granted, font count: ' + fonts.length);
      } catch (e) {
        log('  → denied/error: ' + (e && e.message || e));
      }
    },
  );

  setup('storage',
    typeof document.requestStorageAccess === 'function',
    async () => {
      log('Requesting storage access...');
      try {
        await document.requestStorageAccess();
        log('  → granted');
      } catch (e) {
        log('  → denied/error: ' + (e && e.message || e));
      }
    },
  );
</script>
</body>
</html>`;

async function startPermissionServer() {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return new Response(PERMISSION_PAGE_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  });
  return server;
}

function createPermissionTest(renderer: "cef" | "native") {
  const rendererLabel =
    renderer === "cef" ? "CEF" : "native (WKWebView/WebView2/WebKitGTK)";
  return defineTest({
    name: `Permission prompt - ${rendererLabel}`,
    category: "Permissions (Interactive)",
    description: `Verify the native permission dialog names the specific permission being requested. Exercises the ${rendererLabel} permission delegate path.`,
    interactive: true,
    timeout: 600000,
    async run({ log, showInstructions }) {
      await showInstructions([
        `A page will open in a ${rendererLabel} window with permission-requesting buttons grouped by API family.`,
        "Buttons whose API is unavailable in this renderer are disabled — only enabled buttons can trigger a prompt.",
        "Click an enabled button. The Electrobun dialog should name the specific permission (e.g. 'Camera', 'Geolocation', 'MIDI system-exclusive').",
        "Try a few different buttons, then close the window to pass the test.",
      ]);

      const server = await startPermissionServer();
      const url = `http://127.0.0.1:${server.port}/`;
      log(`Permission test server listening at ${url}`);

      try {
        await new Promise<void>((resolve) => {
          const win = new BrowserWindow({
            title: `Permission Prompt Test (${rendererLabel})`,
            url,
            renderer,
            frame: { width: 500, height: 760, x: 200, y: 100 },
          });

          win.setAlwaysOnTop(true);

          win.on("close", () => {
            log("Permission test window closed");
            resolve();
          });
        });
      } finally {
        server.stop(true);
        log("Permission test server stopped");
      }
    },
  });
}

export const permissionTests = [
  createPermissionTest("cef"),
  createPermissionTest("native"),
];
