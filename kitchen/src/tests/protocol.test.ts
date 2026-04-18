import { BrowserView, Protocol, type CustomScheme } from "electrobun/bun";

import { defineTest, expect } from "../test-framework/types";
import type { TestHarnessRPC } from "../test-harness/index";

function createTestHarnessRPC() {
  return BrowserView.defineRPC<TestHarnessRPC>({
    maxRequestTime: 10000,
    handlers: {
      requests: {
        echo: ({ value }: { value: unknown }) => value,
        add: ({ a, b }: { a: number; b: number }) => a + b,
        throwError: ({ message }: { message?: string }) => {
          throw new Error(message || "Intentional test error");
        },
        delayed: async ({ ms, value }: { ms: number; value: unknown }) => {
          await new Promise((resolve) => setTimeout(resolve, ms));
          return value;
        },
      },
      messages: {
        ping: () => {},
      },
    },
  });
}

async function evaluateInHarness(
  win: Awaited<ReturnType<Parameters<Parameters<typeof defineTest>[0]["run"]>[0]["createWindow"]>>,
  script: string,
) {
  return await (win.webview.rpc as any)?.request.evaluateJavascriptWithResponse({
    script,
  });
}

export const protocolTests = [
  defineTest({
    name: "Custom protocol top-level navigation",
    category: "Protocol",
    description: "Load a top-level custom protocol page in the native renderer",
    async run({ createWindow, log }) {
      let didNavigate = false;
      const win = await createWindow({
        url: "about:blank",
        rpc: createTestHarnessRPC(),
        title: "Protocol Navigation Test",
        renderer: "native",
      });

      win.webview.on("did-navigate", () => {
        didNavigate = true;
      });
      win.webview.loadURL("electrobun-test://app/index.html");

      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(didNavigate).toBe(true);
      log("custom protocol page loaded in native renderer");
    },
  }),
  defineTest({
    name: "Custom protocol top-level navigation in CEF",
    category: "Protocol",
    description: "Load a top-level custom protocol page in the CEF renderer",
    async run({ createWindow, log }) {
      let didNavigate = false;
      const win = await createWindow({
        url: "about:blank",
        rpc: createTestHarnessRPC(),
        title: "Protocol Navigation Test CEF",
        renderer: "cef",
      });

      win.webview.on("did-navigate", () => {
        didNavigate = true;
      });
      win.webview.loadURL("electrobun-test://app/index.html");

      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(didNavigate).toBe(true);
      log("custom protocol page loaded in CEF renderer");
    },
  }),
  defineTest({
    name: "Custom protocol fetch response",
    category: "Protocol",
    description: "Fetch a text response from a custom protocol in the native renderer",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc: createTestHarnessRPC(),
        title: "Protocol Fetch Test",
        renderer: "native",
      });

      await new Promise((resolve) => setTimeout(resolve, 1200));

      const result = await evaluateInHarness(
        win,
        `return fetch("electrobun-test://app/text")
					.then(async (response) => JSON.stringify({
						ok: response.ok,
						status: response.status,
						text: await response.text(),
						header: response.headers.get("x-electrobun-protocol"),
					}))
					.catch((error) => JSON.stringify({ error: String(error) }))`,
      );
      const parsed = JSON.parse(result);

      expect(parsed.error).toBeUndefined();
      expect(parsed.text).toBe("hello from electrobun protocol");
      expect(parsed.header).toBe("ok");
      log("custom protocol text fetch returned expected body and header");
    },
  }),
  defineTest({
    name: "Custom protocol streaming and request body",
    category: "Protocol",
    description:
      "Stream a response body, echo POST content, and preserve large request bodies through a custom protocol in CEF",
    timeout: 30000,
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc: createTestHarnessRPC(),
        title: "Protocol Stream Test",
        renderer: "cef",
      });

      await new Promise((resolve) => setTimeout(resolve, 1500));

      const streamed = await evaluateInHarness(
        win,
        `return fetch("electrobun-test://app/stream")
					.then(async (response) => {
						const reader = response.body.getReader();
						const decoder = new TextDecoder();
						const chunks = [];
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							chunks.push(decoder.decode(value));
						}
						return JSON.stringify({
							ok: response.ok,
							status: response.status,
							chunks,
							text: chunks.join(""),
						});
					})
					.catch((error) => JSON.stringify({ error: String(error) }))`,
      );
      const streamedResult = JSON.parse(streamed);
      expect(streamedResult.error).toBeUndefined();
      expect(streamedResult.chunks.length).toBeGreaterThan(0);
      expect(streamedResult.text).toBe("stream-response");

      const echoed = await evaluateInHarness(
        win,
        `return fetch("electrobun-test://app/echo", { method: "POST", body: "ping-body" })
					.then(async (response) => JSON.stringify({
						ok: response.ok,
						status: response.status,
						text: await response.text(),
					}))
					.catch((error) => JSON.stringify({ error: String(error) }))`,
      );
      const echoedResult = JSON.parse(echoed);
      expect(echoedResult.error).toBeUndefined();
      expect(echoedResult.text).toBe("ping-body");

      const largeBody =
        "A".repeat(1024 * 1024) + "B".repeat(1024 * 1024) + "C".repeat(6 * 1024 * 1024);
      const streamedRequest = await evaluateInHarness(
        win,
        `return fetch("electrobun-test://app/stream-request-order", {
					method: "POST",
					body: ${JSON.stringify(largeBody)},
				})
					.then(async (response) => JSON.stringify({
						ok: response.ok,
						status: response.status,
						payload: await response.json(),
					}))
					.catch((error) => JSON.stringify({ error: String(error) }))`,
      );
      const largeEchoResult = JSON.parse(streamedRequest);
      expect(largeEchoResult.error).toBeUndefined();
      expect(largeEchoResult.payload.chunkCount).toBeGreaterThan(0);
      expect(largeEchoResult.payload.joined.length).toBe(largeBody.length);
      expect(largeEchoResult.payload.joined).toBe(largeBody);

      const noBody = await evaluateInHarness(
        win,
        `return fetch("electrobun-test://app/status/204")
					.then(async (response) => JSON.stringify({
						status: response.status,
						text: await response.text(),
					}))`,
      );
      const noBodyResult = JSON.parse(noBody);
      expect(noBodyResult.status).toBe(204);
      expect(noBodyResult.text).toBe("");
      log("custom protocol streamed response and echoed POST body in CEF");
    },
  }),

  defineTest({
    name: "Custom protocol response properties",
    category: "Protocol",
    description:
      "Verify response.ok, response.type, response.url, response.statusText, response.redirected",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc: createTestHarnessRPC(),
        title: "Protocol Response Properties",
        renderer: "cef",
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));

      const result = await evaluateInHarness(
        win,
        `
        return fetch("electrobun-test://app/text")
          .then(async (r) => JSON.stringify({
            ok: r.ok,
            type: r.type,
            url: r.url,
            statusText: r.statusText,
            redirected: r.redirected,
            status: r.status,
          }))
          .catch((e) => JSON.stringify({ error: String(e) }))
      `,
      );
      const r = JSON.parse(result);
      expect(r.error).toBeUndefined();
      expect(r.ok).toBe(true);
      expect(r.status).toBe(200);
      expect(typeof r.type).toBe("string");
      expect(r.redirected).toBe(false);
      expect(typeof r.url).toBe("string");
      log("response properties verified");
    },
  }),

  defineTest({
    name: "Custom protocol status codes",
    category: "Protocol",
    description: "Verify 201 (ok=true), 400/500 (ok=false), body readable for error statuses",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc: createTestHarnessRPC(),
        title: "Protocol Status Codes",
        renderer: "cef",
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));

      const r201 = JSON.parse(
        await evaluateInHarness(
          win,
          `
        return fetch("electrobun-test://app/status/201")
          .then(async (r) => JSON.stringify({ ok: r.ok, status: r.status, text: await r.text() }))
          .catch((e) => JSON.stringify({ error: String(e) }))
      `,
        ),
      );
      expect(r201.error).toBeUndefined();
      expect(r201.ok).toBe(true);
      expect(r201.status).toBe(201);
      expect(r201.text).toBe("created");

      const r400 = JSON.parse(
        await evaluateInHarness(
          win,
          `
        return fetch("electrobun-test://app/status/400")
          .then(async (r) => JSON.stringify({ ok: r.ok, status: r.status, text: await r.text() }))
          .catch((e) => JSON.stringify({ error: String(e) }))
      `,
        ),
      );
      expect(r400.error).toBeUndefined();
      expect(r400.ok).toBe(false);
      expect(r400.status).toBe(400);
      expect(r400.text).toBe("bad request body");

      const r500 = JSON.parse(
        await evaluateInHarness(
          win,
          `
        return fetch("electrobun-test://app/status/500")
          .then(async (r) => JSON.stringify({ ok: r.ok, status: r.status, text: await r.text() }))
          .catch((e) => JSON.stringify({ error: String(e) }))
      `,
        ),
      );
      expect(r500.error).toBeUndefined();
      expect(r500.ok).toBe(false);
      expect(r500.status).toBe(500);
      log("status codes verified");
    },
  }),

  defineTest({
    name: "Custom protocol HTTP methods",
    category: "Protocol",
    description:
      "PUT, DELETE, OPTIONS methods reach handler; HEAD strips body but preserves headers",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc: createTestHarnessRPC(),
        title: "Protocol Methods",
        renderer: "cef",
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));

      for (const [method, body] of [
        ["PUT", "put-payload"],
        ["DELETE", ""],
        ["OPTIONS", ""],
      ]) {
        const init = body
          ? `{ method: "${method}", body: ${JSON.stringify(body)} }`
          : `{ method: "${method}" }`;
        const raw = await evaluateInHarness(
          win,
          `
          return fetch("electrobun-test://app/echo-method", ${init})
            .then(async (r) => JSON.stringify({ ok: r.ok, payload: await r.json() }))
            .catch((e) => JSON.stringify({ error: String(e) }))
        `,
        );
        const r = JSON.parse(raw);
        expect(r.error).toBeUndefined();
        expect(r.payload.method).toBe(method);
        if (body) expect(r.payload.body).toBe(body);
      }

      const headRaw = await evaluateInHarness(
        win,
        `
        return fetch("electrobun-test://app/head-resource", { method: "HEAD" })
          .then(async (r) => JSON.stringify({
            ok: r.ok,
            status: r.status,
            xResourceId: r.headers.get("x-resource-id"),
            bodyText: await r.text(),
          }))
          .catch((e) => JSON.stringify({ error: String(e) }))
      `,
      );
      const head = JSON.parse(headRaw);
      expect(head.error).toBeUndefined();
      expect(head.ok).toBe(true);
      expect(head.xResourceId).toBe("head-test");
      expect(head.bodyText).toBe("");
      log("PUT, DELETE, OPTIONS, HEAD methods verified");
    },
  }),

  defineTest({
    name: "Custom protocol headers API",
    category: "Protocol",
    description:
      "headers.has(), headers.forEach(), iteration, multiple same-name values, custom request header forwarding",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc: createTestHarnessRPC(),
        title: "Protocol Headers API",
        renderer: "native",
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));

      const raw = await evaluateInHarness(
        win,
        `
        return fetch("electrobun-test://app/headers/echo-request", {
          headers: { "x-custom-req": "hello-from-browser" },
        })
          .then(async (r) => {
            const body = await r.json();
            const has = r.headers.has("content-type");
            const entries = [];
            r.headers.forEach((v, k) => entries.push([k, v]));
            return JSON.stringify({ echoed: body, has, entries });
          })
          .catch((e) => JSON.stringify({ error: String(e) }))
      `,
      );
      const r = JSON.parse(raw);
      expect(r.error).toBeUndefined();
      expect(r.echoed["x-custom-req"]).toBe("hello-from-browser");
      expect(r.has).toBe(true);
      expect(Array.isArray(r.entries)).toBe(true);
      expect(r.entries.length).toBeGreaterThan(0);

      const multiRaw = await evaluateInHarness(
        win,
        `
        return fetch("electrobun-test://app/headers/multi")
          .then((r) => JSON.stringify({
            xMulti: r.headers.get("x-multi"),
            hasXMulti: r.headers.has("x-multi"),
          }))
          .catch((e) => JSON.stringify({ error: String(e) }))
      `,
      );
      const multi = JSON.parse(multiRaw);
      expect(multi.error).toBeUndefined();
      expect(multi.hasXMulti).toBe(true);
      expect(multi.xMulti).toContain("first");
      expect(multi.xMulti).toContain("second");
      log("headers API verified");
    },
  }),

  defineTest({
    name: "Custom protocol body consumption methods",
    category: "Protocol",
    description: "arrayBuffer(), bytes(), blob(), formData(), bodyUsed, clone()",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc: createTestHarnessRPC(),
        title: "Protocol Body Consumption",
        renderer: "cef",
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const abRaw = await evaluateInHarness(
        win,
        `
        return fetch("electrobun-test://app/text")
          .then(async (r) => {
            const ab = await r.arrayBuffer();
            return JSON.stringify({ byteLength: ab.byteLength, type: ab.constructor.name });
          })
          .catch((e) => JSON.stringify({ error: String(e) }))
      `,
      );
      const ab = JSON.parse(abRaw);
      expect(ab.error).toBeUndefined();
      expect(ab.byteLength).toBeGreaterThan(0);
      expect(ab.type).toBe("ArrayBuffer");

      const bytesRaw = await evaluateInHarness(
        win,
        `
        return fetch("electrobun-test://app/text")
          .then(async (r) => {
            const b = await r.bytes();
            return JSON.stringify({ type: b.constructor.name, length: b.length });
          })
          .catch((e) => JSON.stringify({ error: String(e) }))
      `,
      );
      const bytes = JSON.parse(bytesRaw);
      expect(bytes.error).toBeUndefined();
      expect(bytes.type).toBe("Uint8Array");
      expect(bytes.length).toBeGreaterThan(0);

      const blobRaw = await evaluateInHarness(
        win,
        `
        return fetch("electrobun-test://app/text")
          .then(async (r) => {
            const b = await r.blob();
            return JSON.stringify({ type: b.type, size: b.size });
          })
          .catch((e) => JSON.stringify({ error: String(e) }))
      `,
      );
      const blob = JSON.parse(blobRaw);
      expect(blob.error).toBeUndefined();
      expect(blob.size).toBeGreaterThan(0);

      const fdRaw = await evaluateInHarness(
        win,
        `
        return fetch("electrobun-test://app/body/formdata")
          .then(async (r) => {
            const fd = await r.formData();
            return JSON.stringify({ field1: fd.get("field1"), field2: fd.get("field2") });
          })
          .catch((e) => JSON.stringify({ error: String(e) }))
      `,
      );
      const fd = JSON.parse(fdRaw);
      expect(fd.error).toBeUndefined();
      expect(fd.field1).toBe("hello");
      expect(fd.field2).toBe("world");

      const cloneRaw = await evaluateInHarness(
        win,
        `
        return fetch("electrobun-test://app/text")
          .then(async (r) => {
            const c = r.clone();
            const [t1, t2] = await Promise.all([r.text(), c.text()]);
            return JSON.stringify({ t1, t2, match: t1 === t2 });
          })
          .catch((e) => JSON.stringify({ error: String(e) }))
      `,
      );
      const clone = JSON.parse(cloneRaw);
      expect(clone.error).toBeUndefined();
      expect(clone.match).toBe(true);
      expect(clone.t1).toBe("hello from electrobun protocol");

      const bodyUsedRaw = await evaluateInHarness(
        win,
        `
        return fetch("electrobun-test://app/text")
          .then(async (r) => {
            const before = r.bodyUsed;
            await r.text();
            const after = r.bodyUsed;
            let threw = false;
            try { await r.text(); } catch { threw = true; }
            return JSON.stringify({ before, after, threw });
          })
          .catch((e) => JSON.stringify({ error: String(e) }))
      `,
      );
      const bodyUsed = JSON.parse(bodyUsedRaw);
      expect(bodyUsed.error).toBeUndefined();
      expect(bodyUsed.before).toBe(false);
      expect(bodyUsed.after).toBe(true);
      expect(bodyUsed.threw).toBe(true);
      log("body consumption methods and bodyUsed verified");
    },
  }),

  defineTest({
    name: "Custom protocol binary body",
    category: "Protocol",
    description:
      "Binary response preserved byte-for-byte via arrayBuffer(); binary request body round-trips",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc: createTestHarnessRPC(),
        title: "Protocol Binary",
        renderer: "cef",
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const binRaw = await evaluateInHarness(
        win,
        `
        return fetch("electrobun-test://app/body/binary")
          .then(async (r) => {
            const ab = await r.arrayBuffer();
            const u8 = new Uint8Array(ab);
            let allCorrect = true;
            for (let i = 0; i < 256; i++) {
              if (u8[i] !== i) { allCorrect = false; break; }
            }
            return JSON.stringify({ length: u8.length, allCorrect });
          })
          .catch((e) => JSON.stringify({ error: String(e) }))
      `,
      );
      const bin = JSON.parse(binRaw);
      expect(bin.error).toBeUndefined();
      expect(bin.length).toBe(256);
      expect(bin.allCorrect).toBe(true);

      const echoRaw = await evaluateInHarness(
        win,
        `
        const body = new Uint8Array(128);
        for (let i = 0; i < 128; i++) body[i] = i * 2;
        return fetch("electrobun-test://app/body/echo-binary", {
          method: "POST",
          body: body.buffer,
        })
          .then(async (r) => {
            const ab = await r.arrayBuffer();
            const u8 = new Uint8Array(ab);
            let allCorrect = true;
            for (let i = 0; i < 128; i++) {
              if (u8[i] !== i * 2) { allCorrect = false; break; }
            }
            return JSON.stringify({ length: u8.length, allCorrect });
          })
          .catch((e) => JSON.stringify({ error: String(e) }))
      `,
      );
      const echo = JSON.parse(echoRaw);
      expect(echo.error).toBeUndefined();
      expect(echo.length).toBe(128);
      expect(echo.allCorrect).toBe(true);
      log("binary body round-trip verified");
    },
  }),

  defineTest({
    name: "Custom protocol stream chunks are Uint8Array",
    category: "Protocol",
    description: "Spec §2.2.4: response body stream yields Uint8Array chunks, not strings",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc: createTestHarnessRPC(),
        title: "Protocol Stream Uint8Array",
        renderer: "cef",
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const raw = await evaluateInHarness(
        win,
        `
        return fetch("electrobun-test://app/stream")
          .then(async (r) => {
            const reader = r.body.getReader();
            const types = [];
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              types.push(value.constructor.name);
            }
            return JSON.stringify({ types, allUint8: types.every(t => t === "Uint8Array") });
          })
          .catch((e) => JSON.stringify({ error: String(e) }))
      `,
      );
      const r = JSON.parse(raw);
      expect(r.error).toBeUndefined();
      expect(r.allUint8).toBe(true);
      expect(r.types.length).toBeGreaterThan(0);
      log("stream chunks are Uint8Array");
    },
  }),

  defineTest({
    name: "Custom protocol URLSearchParams and urlencoded body",
    category: "Protocol",
    description:
      "URLSearchParams request body and application/x-www-form-urlencoded response via formData()",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc: createTestHarnessRPC(),
        title: "Protocol URLSearchParams",
        renderer: "native",
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));

      const sendRaw = await evaluateInHarness(
        win,
        `
        return fetch("electrobun-test://app/echo", {
          method: "POST",
          body: new URLSearchParams({ a: "1", b: "2" }),
        })
          .then(async (r) => JSON.stringify({ text: await r.text(), ct: r.headers.get("content-type") }))
          .catch((e) => JSON.stringify({ error: String(e) }))
      `,
      );
      const send = JSON.parse(sendRaw);
      expect(send.error).toBeUndefined();
      expect(send.text).toContain("a=1");
      expect(send.text).toContain("b=2");

      const recvRaw = await evaluateInHarness(
        win,
        `
        return fetch("electrobun-test://app/body/urlencoded")
          .then(async (r) => {
            const fd = await r.formData();
            return JSON.stringify({ key: fd.get("key"), foo: fd.get("foo") });
          })
          .catch((e) => JSON.stringify({ error: String(e) }))
      `,
      );
      const recv = JSON.parse(recvRaw);
      expect(recv.error).toBeUndefined();
      expect(recv.key).toBe("value");
      expect(recv.foo).toBe("bar");
      log("URLSearchParams and urlencoded body verified");
    },
  }),

  defineTest({
    name: "Custom protocol AbortController",
    category: "Protocol",
    description:
      "Abort before response rejects with AbortError; abort during streaming errors the body stream",
    async run({ createWindow, log }) {
      const win = await createWindow({
        url: "views://test-harness/index.html",
        rpc: createTestHarnessRPC(),
        title: "Protocol Abort",
        renderer: "cef",
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const abortBeforeRaw = await evaluateInHarness(
        win,
        `
        const ac = new AbortController();
        ac.abort();
        return fetch("electrobun-test://app/text", { signal: ac.signal })
          .then(() => JSON.stringify({ aborted: false }))
          .catch((e) => JSON.stringify({ aborted: true, name: e.name }))
      `,
      );
      const abortBefore = JSON.parse(abortBeforeRaw);
      expect(abortBefore.aborted).toBe(true);
      expect(abortBefore.name).toBe("AbortError");

      const abortDuringRaw = await evaluateInHarness(
        win,
        `
        const ac = new AbortController();
        let errorName = null;
        const p = fetch("electrobun-test://app/body/slow-stream", { signal: ac.signal })
          .then(async (r) => {
            const reader = r.body.getReader();
            await reader.read();
            ac.abort();
            try {
              while (true) {
                const { done } = await reader.read();
                if (done) break;
              }
            } catch (e) {
              errorName = e.name;
            }
            return JSON.stringify({ aborted: ac.signal.aborted, errorName });
          })
          .catch((e) => JSON.stringify({ fetchAborted: true, name: e.name }));
        return p;
      `,
      );
      const abortDuring = JSON.parse(abortDuringRaw);
      if (abortDuring.fetchAborted) {
        expect(abortDuring.name).toBe("AbortError");
      } else {
        expect(abortDuring.aborted).toBe(true);
      }
      log("AbortController verified");
    },
  }),

  defineTest({
    name: "Custom protocol handler lifecycle",
    category: "Protocol",
    description:
      "Protocol.isHandled(), Protocol.unhandle(), Protocol.getHandledSchemes(), and declaration enforcement",
    async run({ log }) {
      expect(Protocol.isHandled("electrobun-test")).toBe(true);

      const handled = Protocol.getHandledSchemes();
      expect(handled).toContain("electrobun-test");
      expect(Array.isArray(handled)).toBe(true);

      const declared = Protocol.getRegisteredSchemes();
      expect(declared.some((s: CustomScheme) => s.scheme === "electrobun-test")).toBe(true);

      const unhandled = Protocol.unhandle("electrobun-test");
      expect(unhandled).toBe(true);
      expect(Protocol.isHandled("electrobun-test")).toBe(false);
      expect(Protocol.getHandledSchemes().includes("electrobun-test")).toBe(false);

      const unhandledAgain = Protocol.unhandle("electrobun-test");
      expect(unhandledAgain).toBe(false);

      await Protocol.handle("electrobun-test", async () =>
        new Response("restored", { headers: { "content-type": "text/plain; charset=utf-8" } }),
      );

      expect(Protocol.isHandled("electrobun-test")).toBe(true);

      log("handler lifecycle verified: isHandled, unhandle, getHandledSchemes, getRegisteredSchemes");
    },
  }),

  defineTest({
    name: "Custom protocol declaration enforcement",
    category: "Protocol",
    description: "Protocol.handle() throws when scheme was not declared in electrobun.config.ts",
    async run({ log }) {
      let threw = false;
      let errorMsg = "";
      try {
        await Protocol.handle("not-declared-scheme", async () => new Response("x"));
      } catch (e) {
        threw = true;
        errorMsg = e instanceof Error ? e.message : String(e);
      }

      expect(threw).toBe(true);
      expect(errorMsg).toContain("not-declared-scheme");
      expect(errorMsg).toContain("not declared in electrobun.config.ts");
      log("declaration enforcement verified");
    },
  }),

  defineTest({
    name: "Custom protocol reserved scheme rejection",
    category: "Protocol",
    description: "Protocol.handle() throws for reserved schemes like http and https",
    async run({ log }) {
      for (const reserved of ["http", "https", "file", "views"]) {
        let threw = false;
        try {
          await Protocol.handle(reserved, async () => new Response("x"));
        } catch {
          threw = true;
        }
        expect(threw).toBe(true);
      }

      log("reserved scheme rejection verified");
    },
  }),
];
