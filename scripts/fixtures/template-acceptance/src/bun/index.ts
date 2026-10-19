import { BrowserView, BrowserWindow, Utils } from "electrobun/main";
import Database from "bun:sqlite";
import { writeFileSync } from "node:fs";
import type { AcceptanceRPC } from "../rpc";

const token = process.env.ELECTROBUN_ACCEPTANCE_TOKEN!;
const report = process.env.ELECTROBUN_ACCEPTANCE_REPORT!;
const checks: string[] = [];
function passed(check: string) {
	checks.push(check);
	console.log(`[template-acceptance] passed ${check}`);
}
console.log("[template-acceptance] main process started");
let finished = false;
function finish(error?: unknown) {
	if (finished) return;
	finished = true;
	writeFileSync(report, JSON.stringify({ token, checks, ok: !error, error: error ? String(error) : null, platform: process.platform, runtimeVersion: process.versions.cottontail }));
	Utils.quit(error ? 1 : 0);
}
setTimeout(() => finish(new Error("renderer/RPC deadline exceeded")), 30_000);

try {
	// These APIs must survive capability auto-detection and runtime packaging.
	if (typeof Bun.SQL !== "function") throw new Error("SQL capability missing");
	passed("sql");
	const db = new Database(":memory:");
	const row = db.query("select 42 as answer").get() as { answer: number };
	if (row.answer !== 42) throw new Error("SQLite query failed");
	db.close();
	passed("sqlite");
	// Computed lookup deliberately requires the explicit hashing config override.
	const Hash = (Bun as any)[process.env.ELECTROBUN_ACCEPTANCE_API!];
	if (new Hash("sha256").update("abc").digest("hex") !== "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") throw new Error("explicit hashing capability failed");
	passed("hashing-override");
	const rpc = BrowserView.defineRPC<AcceptanceRPC>({ handlers: {
		requests: { challenge: ({ text }) => {
			if (text !== "Renderer → native Ω") throw new Error("RPC request corrupted");
			passed("rpc-request");
			return token;
		} },
		messages: { complete: (value) => {
			if (value.token !== token || value.text !== "Renderer → native Ω") return finish(new Error("RPC response corrupted"));
			passed("webview");
			passed("rpc-roundtrip");
			finish();
		} },
	} });
	new BrowserWindow({ title: "Template acceptance", url: "views://mainview/index.html", rpc, frame: { x: 100, y: 100, width: 400, height: 300 } });
} catch (error) {
	finish(error);
}
