// Interactive Permission Prompt Tests
//
// These tests host a tiny localhost page and load it in a CEF window so the
// origin is NOT views://. That bypasses the auto-accept short-circuit in the
// native permission handler and lets us exercise the real prompt path,
// including the named-permission dialog produced by describeCefPermissions().

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
  p { margin: 0 0 16px 0; color: #555; font-size: 13px; }
  button {
    display: block;
    width: 100%;
    margin: 6px 0;
    padding: 10px 14px;
    font-size: 14px;
    text-align: left;
    border: 1px solid #ccc;
    border-radius: 6px;
    background: #f7f7f7;
    cursor: pointer;
  }
  button:hover { background: #ececec; }
  button code { color: #888; font-size: 11px; }
  #log {
    margin-top: 16px;
    padding: 10px;
    background: #f0f0f0;
    border-radius: 6px;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    white-space: pre-wrap;
    max-height: 200px;
    overflow-y: auto;
  }
</style>
</head>
<body>
  <h1>Permission Prompt Test</h1>
  <p>Click a button to trigger a permission request. The Electrobun dialog
  should name the specific permission being asked for.</p>

  <button id="midi">Request MIDI sysex<br><code>navigator.requestMIDIAccess({sysex: true})</code></button>
  <button id="idle">Request idle detection<br><code>IdleDetector.requestPermission()</code></button>
  <button id="window-mgmt">Request window management<br><code>window.getScreenDetails()</code></button>
  <button id="fonts">Request local fonts<br><code>window.queryLocalFonts()</code></button>
  <button id="storage">Request storage access<br><code>document.requestStorageAccess()</code></button>

  <div id="log">Click a button above to begin.</div>

<script>
  const logEl = document.getElementById('log');
  function log(msg) {
    logEl.textContent = msg + '\\n' + logEl.textContent;
  }

  document.getElementById('midi').addEventListener('click', async () => {
    log('Requesting MIDI sysex...');
    try {
      const access = await navigator.requestMIDIAccess({ sysex: true });
      log('  → granted: ' + access.constructor.name);
    } catch (e) {
      log('  → denied/error: ' + (e && e.message || e));
    }
  });

  document.getElementById('idle').addEventListener('click', async () => {
    log('Requesting idle detection...');
    if (typeof IdleDetector === 'undefined') {
      log('  → IdleDetector unavailable in this build');
      return;
    }
    try {
      const result = await IdleDetector.requestPermission();
      log('  → result: ' + result);
    } catch (e) {
      log('  → error: ' + (e && e.message || e));
    }
  });

  document.getElementById('window-mgmt').addEventListener('click', async () => {
    log('Requesting window management...');
    try {
      const details = await window.getScreenDetails();
      log('  → granted, screens: ' + details.screens.length);
    } catch (e) {
      log('  → denied/error: ' + (e && e.message || e));
    }
  });

  document.getElementById('fonts').addEventListener('click', async () => {
    log('Requesting local fonts...');
    if (typeof window.queryLocalFonts !== 'function') {
      log('  → queryLocalFonts unavailable in this build');
      return;
    }
    try {
      const fonts = await window.queryLocalFonts();
      log('  → granted, font count: ' + fonts.length);
    } catch (e) {
      log('  → denied/error: ' + (e && e.message || e));
    }
  });

  document.getElementById('storage').addEventListener('click', async () => {
    log('Requesting storage access...');
    try {
      await document.requestStorageAccess();
      log('  → granted');
    } catch (e) {
      log('  → denied/error: ' + (e && e.message || e));
    }
  });
</script>
</body>
</html>`;

async function startPermissionServer() {
  const server = Bun.serve({
    port: 0, // random free port
    hostname: "127.0.0.1",
    fetch() {
      return new Response(PERMISSION_PAGE_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  });
  return server;
}

export const permissionTests = [
  defineTest({
    name: "Permission prompt - named-permission dialog",
    category: "Permissions (Interactive)",
    description:
      "Verify the native permission dialog names the specific permission being requested (decoded from the CEF bitmask).",
    interactive: true,
    timeout: 600000, // 10 minutes for exploration
    async run({ log, showInstructions }) {
      await showInstructions([
        "A page will open with several permission-requesting buttons.",
        "Click any button to trigger a permission request.",
        "The Electrobun dialog should name the specific permission (e.g. 'MIDI system-exclusive', 'Idle detection', 'Window management').",
        "Try a few different buttons, then close the window to pass the test.",
      ]);

      const server = await startPermissionServer();
      const url = `http://127.0.0.1:${server.port}/`;
      log(`Permission test server listening at ${url}`);

      try {
        await new Promise<void>((resolve) => {
          const win = new BrowserWindow({
            title: "Permission Prompt Test",
            url,
            renderer: "cef",
            frame: { width: 480, height: 600, x: 200, y: 100 },
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
  }),
];
