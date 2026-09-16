import { mkdir, rm, symlink, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { Utils } from "electrobun/main";
import { defineTest, expect } from "../test-framework/types";
import { createTestHarnessRPC } from "./rpc.test";

const fixtureName = "kitchen-appdata-protocol.txt";
const fixtureContents = "electrobun-appdata-protocol-ok";
const escapeFixtureName = "kitchen-appdata-escape-target.txt";
const symlinkFixtureName = "kitchen-appdata-escape-link.txt";

async function writeFixture() {
  await mkdir(Utils.paths.userData, { recursive: true });
  await writeFile(join(Utils.paths.userData, fixtureName), fixtureContents, "utf8");
  const escapeTarget = join(dirname(Utils.paths.userData), escapeFixtureName);
  const symlinkPath = join(Utils.paths.userData, symlinkFixtureName);
  await writeFile(escapeTarget, "must-not-be-readable", "utf8");
  await rm(symlinkPath, { force: true });
  try {
    await symlink(escapeTarget, symlinkPath);
    return true;
  } catch (error: any) {
    if (error?.code === "EPERM" || error?.code === "EACCES") return false;
    throw error;
  }
}

function protocolTest(enabled: boolean) {
  const expectation = enabled ? "allows" : "denies";
  return defineTest({
    name: `appdata protocol ${expectation} access`,
    category: "Protocols",
    description: `Verifies appdata:// is ${expectation === "allows" ? "readable" : "blocked"} when requesting CEF, including the automatic system-webview fallback when CEF is not bundled`,
    timeout: 30000,
    async run({ createWindow, log }) {
      const hasSymlinkFixture = await writeFixture();
      const win = await createWindow({
        url: "views://test-harness/index.html",
        renderer: "cef",
        rpc: createTestHarnessRPC(2000),
        allowedProtocols: { views: true, appData: enabled },
      });

      const rpc = win.webview.rpc;
      if (!rpc) throw new Error("Expected test harness RPC to be available");

      await new Promise((resolve) => setTimeout(resolve, 1500));
      const readinessDeadline = Date.now() + 15000;
      let readinessError: unknown;
      for (;;) {
        try {
          if (await rpc.request.multiply({ a: 6, b: 7 }) === 42) break;
        } catch (error) {
          readinessError = error;
        }
        if (Date.now() >= readinessDeadline) {
          throw new Error(
            `Timed out waiting for appdata test harness RPC: ${String(readinessError)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const result = await rpc.request.evaluateJavascriptWithResponse({
        script: `return fetch("appdata://${fixtureName}")
          .then(async response => ({ ok: response.ok, status: response.status, text: await response.text() }))
          .catch(error => ({ ok: false, status: 0, text: String(error) }));`,
      });

      if (enabled) {
        expect(result?.ok).toBe(true);
        expect(result?.text).toBe(fixtureContents);

        const escapeUrls = [
          `appdata://%2e%2e/${escapeFixtureName}`,
          ...(hasSymlinkFixture ? [`appdata://${symlinkFixtureName}`] : []),
        ];
        const escapeResults = await rpc.request.evaluateJavascriptWithResponse({
          script: `return Promise.all(${JSON.stringify(escapeUrls)}.map(url => fetch(url)
            .then(async response => ({ ok: response.ok, text: await response.text() }))
            .catch(error => ({ ok: false, text: String(error) }))));`,
        });
        expect(escapeResults?.[0]?.ok).toBe(false);
        if (hasSymlinkFixture) expect(escapeResults?.[1]?.ok).toBe(false);
      } else {
        expect(result?.ok).toBe(false);
        expect(result?.text === fixtureContents).toBe(false);
      }
      log(`appdata access ${expectation}: ${JSON.stringify(result)}`);
    },
  });
}

export const appDataProtocolTests = [
  protocolTest(true),
  protocolTest(false),
];
