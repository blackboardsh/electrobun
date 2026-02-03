import { BrowserWindow } from "electrobun";

// These are DOM APIs that do NOT exist in Bun.
// With "lib": ["ESNext"] (no DOM), these should all be type errors.
// If they pass, DOM types are leaking through electrobun's dependency chain.

// @ts-expect-error - DOMParser should not exist in a non-DOM context
const parser = new DOMParser();

// BroadcastChannel is a valid Bun/Web API (in @types/bun), not DOM-only
const channel = new BroadcastChannel("test");

// @ts-expect-error - document should not exist in a non-DOM context
const el = document.createElement("div");

console.log(BrowserWindow, parser, channel, el);
