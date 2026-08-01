import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const header = readFileSync(
	join(import.meta.dirname, "../native/shared/console_forwarding.h"),
	"utf8",
);
const scriptMatch = header.match(
	/R"ELECTROBUN_JS\(\n([\s\S]*?)\n\)ELECTROBUN_JS"/,
);
if (!scriptMatch?.[1]) throw new Error("Embedded console forwarding script was not found");
const forwardingScript = scriptMatch[1];

type ConsoleMethod = "debug" | "log" | "info" | "warn" | "error";

function createConsole() {
	const calls: Array<{ level: ConsoleMethod; args: unknown[] }> = [];
	const consoleObject = {} as Record<ConsoleMethod, (...args: unknown[]) => void>;
	for (const level of ["debug", "log", "info", "warn", "error"] as const) {
		consoleObject[level] = (...args) => calls.push({ level, args });
	}
	return { calls, consoleObject };
}

function install(
	globalObject: Record<string, unknown>,
	consoleObject: Record<ConsoleMethod, (...args: unknown[]) => void>,
) {
	new Function("globalThis", "console", forwardingScript)(globalObject, consoleObject);
}

describe("native webview console forwarding", () => {
	it("forwards WebKit messages while preserving the original console call", () => {
		const messages: string[] = [];
		const { calls, consoleObject } = createConsole();
		const globalObject = {
			webkit: {
				messageHandlers: {
					electrobunConsole: { postMessage: (message: string) => messages.push(message) },
				},
			},
		};

		install(globalObject, consoleObject);
		consoleObject.log("hello", { answer: 42 }, 3n);

		expect(messages).toEqual([`[console.log] hello {"answer":42} 3n`]);
		expect(calls).toEqual([{ level: "log", args: ["hello", { answer: 42 }, 3n] }]);
	});

	it("supports WebView2, circular values, errors, and idempotent installation", () => {
		const messages: string[] = [];
		const { consoleObject } = createConsole();
		const globalObject = {
			chrome: {
				webview: {
					hostObjects: {
						sync: {
							electrobunConsole: {
								postMessage: (message: string) => messages.push(message),
							},
						},
					},
				},
			},
		};
		const circular: Record<string, unknown> = {};
		circular["self"] = circular;

		install(globalObject, consoleObject);
		install(globalObject, consoleObject);
		consoleObject.warn("state", circular);
		consoleObject.error(new Error("boom"));

		expect(messages[0]).toBe(`[console.warn] state {"self":"[Circular]"}`);
		expect(messages[1]).toContain("[console.error] Error: boom");
		expect(messages).toHaveLength(2);
	});
});
