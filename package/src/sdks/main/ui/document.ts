// A small DOM-compatible facade over the native UI core. Nodes mirror their
// tree in JS (so traversal is synchronous and free) and every mutation is
// appended to a command buffer that crosses FFI once per microtask. The
// warren DOM renderer (browser/ui/dom.ts) runs on top of this unchanged, so
// the same JSX renders in a webview or straight to the GPU.
import { ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { uiLib } from "./ffi";

/** An element's border box in window content coordinates (CSS px). */
export interface UIRect {
	x: number;
	y: number;
	width: number;
	height: number;
	/** false when the element is removed, display:none, hidden, or empty */
	visible: boolean;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

const enum Op {
	createElement = 1,
	createText = 2,
	insertBefore = 3,
	remove = 4,
	destroy = 5,
	setAttribute = 6,
	removeAttribute = 7,
	setText = 8,
	setStyle = 9,
	listen = 10,
	unlisten = 11,
	createComment = 12,
	setValue = 13,
	focus = 14,
}

class CommandBuffer {
	bytes = new Uint8Array(1 << 16);
	view = new DataView(this.bytes.buffer);
	len = 0;

	private ensure(n: number) {
		if (this.len + n <= this.bytes.length) return;
		let cap = this.bytes.length * 2;
		while (cap < this.len + n) cap *= 2;
		const next = new Uint8Array(cap);
		next.set(this.bytes.subarray(0, this.len));
		this.bytes = next;
		this.view = new DataView(next.buffer);
	}
	u8(v: number) {
		this.ensure(1);
		this.bytes[this.len++] = v;
	}
	u32(v: number) {
		this.ensure(4);
		this.view.setUint32(this.len, v >>> 0, true);
		this.len += 4;
	}
	str(s: string) {
		// worst case 3 bytes per UTF-16 unit
		this.ensure(4 + s.length * 3);
		const res = enc.encodeInto(s, this.bytes.subarray(this.len + 4));
		this.view.setUint32(this.len, res.written!, true);
		this.len += 4 + res.written!;
	}
}


function strArgs(s: string): [Pointer, number] {
	const b = enc.encode(s);
	const holder = b.length ? b : new Uint8Array(1);
	return [ptr(holder), b.length];
}

export const SVG_NS = "http://www.w3.org/2000/svg";

type Listener = (ev: NativeEvent) => void;

export class NativeNode {
	parentNode: NativeElement | null = null;
	firstChild: NativeNode | null = null;
	lastChild: NativeNode | null = null;
	nextSibling: NativeNode | null = null;
	previousSibling: NativeNode | null = null;
	constructor(
		readonly ownerDocument: NativeDocument,
		readonly id: number,
		readonly nodeType: number,
	) {}

	get childNodes(): NativeNode[] {
		const out: NativeNode[] = [];
		for (let c = this.firstChild; c; c = c.nextSibling) out.push(c);
		return out;
	}
	get parentElement(): NativeElement | null {
		return this.parentNode;
	}
	get isConnected(): boolean {
		let n: NativeNode | null = this;
		while (n) {
			if (n === this.ownerDocument.body) return true;
			n = n.parentNode;
		}
		return false;
	}

	insertBefore<T extends NativeNode>(node: T, before: NativeNode | null): T {
		const doc = this.ownerDocument;
		if (node.parentNode) node.parentNode.unlink(node);
		const self = this as unknown as NativeElement;
		node.parentNode = self;
		if (before && before.parentNode === self) {
			node.nextSibling = before;
			node.previousSibling = before.previousSibling;
			if (before.previousSibling) before.previousSibling.nextSibling = node;
			else this.firstChild = node;
			before.previousSibling = node;
		} else {
			before = null;
			node.previousSibling = this.lastChild;
			node.nextSibling = null;
			if (this.lastChild) this.lastChild.nextSibling = node;
			else this.firstChild = node;
			this.lastChild = node;
		}
		doc.attached(node);
		doc.cmd(Op.insertBefore).u32(this.id);
		doc.buf.u32(node.id);
		doc.buf.u32(before ? before.id : 0);
		return node;
	}
	appendChild<T extends NativeNode>(node: T): T {
		return this.insertBefore(node, null);
	}
	removeChild<T extends NativeNode>(node: T): T {
		if (node.parentNode !== (this as unknown)) return node;
		this.unlink(node);
		const doc = this.ownerDocument;
		doc.cmd(Op.remove).u32(node.id);
		doc.detached(node);
		return node;
	}
	remove(): void {
		this.parentNode?.removeChild(this);
	}
	replaceWith(node: NativeNode): void {
		const p = this.parentNode;
		if (!p) return;
		p.insertBefore(node, this);
		p.removeChild(this);
	}
	/** internal: unlink from the JS mirror only */
	unlink(node: NativeNode): void {
		if (node.previousSibling) node.previousSibling.nextSibling = node.nextSibling;
		else this.firstChild = node.nextSibling;
		if (node.nextSibling) node.nextSibling.previousSibling = node.previousSibling;
		else this.lastChild = node.previousSibling;
		node.parentNode = null;
		node.nextSibling = null;
		node.previousSibling = null;
	}

	get textContent(): string {
		let s = "";
		for (let c = this.firstChild; c; c = c.nextSibling) s += c.textContent;
		return s;
	}
	set textContent(value: string) {
		while (this.firstChild) {
			const c = this.firstChild;
			this.removeChild(c);
		}
		if (value) this.appendChild(this.ownerDocument.createTextNode(value));
	}
}

export class NativeText extends NativeNode {
	private _data: string;
	constructor(doc: NativeDocument, id: number, data: string) {
		super(doc, id, 3);
		this._data = data;
	}
	get data(): string {
		return this._data;
	}
	set data(v: string) {
		if (v === this._data) return;
		this._data = v;
		this.ownerDocument.cmd(Op.setText).u32(this.id);
		this.ownerDocument.buf.str(v);
	}
	get nodeValue(): string {
		return this._data;
	}
	set nodeValue(v: string) {
		this.data = v;
	}
	override get textContent(): string {
		return this._data;
	}
	override set textContent(v: string) {
		this.data = v;
	}
}

export class NativeComment extends NativeNode {
	constructor(
		doc: NativeDocument,
		id: number,
		readonly data: string,
	) {
		super(doc, id, 8);
	}
	override get textContent(): string {
		return "";
	}
}

function kebab(name: string): string {
	if (name.startsWith("--")) return name;
	return name.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}

function createStyle(el: NativeElement): Record<string, any> {
	const values = new Map<string, string>();
	const api = {
		setProperty(name: string, value: string) {
			const k = kebab(name);
			if (value === "" || value == null) values.delete(k);
			else values.set(k, String(value));
			el.ownerDocument.cmd(Op.setStyle).u32(el.id);
			el.ownerDocument.buf.str(k);
			el.ownerDocument.buf.str(value == null ? "" : String(value));
		},
		removeProperty(name: string) {
			api.setProperty(name, "");
		},
		getPropertyValue(name: string) {
			return values.get(kebab(name)) ?? "";
		},
		get cssText() {
			return Array.from(values, ([k, v]) => `${k}: ${v}`).join("; ");
		},
		set cssText(text: string) {
			values.clear();
			for (const decl of text.split(";")) {
				const i = decl.indexOf(":");
				if (i > 0) values.set(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
			}
			el.setAttribute("style", text);
		},
	};
	return new Proxy(api as Record<string, any>, {
		get(target, key) {
			if (typeof key !== "string") return undefined;
			if (key in target) return target[key];
			return values.get(kebab(key)) ?? "";
		},
		set(target, key, value) {
			if (typeof key !== "string") return false;
			if (key === "cssText") {
				target["cssText"] = value;
				return true;
			}
			api.setProperty(key, value);
			return true;
		},
	});
}

export class NativeElement extends NativeNode {
	readonly tagName: string;
	readonly localName: string;
	private attrs = new Map<string, string>();
	private listeners = new Map<string, Set<Listener>>();
	private _style: Record<string, any> | null = null;
	private classes: Set<string> | null = null;
	constructor(
		doc: NativeDocument,
		id: number,
		tag: string,
		readonly namespaceURI: string | null,
	) {
		super(doc, id, 1);
		this.localName = tag.toLowerCase();
		this.tagName = tag.toUpperCase();
	}

	getAttribute(name: string): string | null {
		return this.attrs.get(name.toLowerCase()) ?? null;
	}
	hasAttribute(name: string): boolean {
		return this.attrs.has(name.toLowerCase());
	}
	setAttribute(name: string, value: string): void {
		const n = name.toLowerCase();
		const v = String(value);
		this.attrs.set(n, v);
		if (n === "class") this.classes = null;
		this.ownerDocument.cmd(Op.setAttribute).u32(this.id);
		this.ownerDocument.buf.str(n);
		this.ownerDocument.buf.str(v);
	}
	removeAttribute(name: string): void {
		const n = name.toLowerCase();
		if (!this.attrs.delete(n)) return;
		if (n === "class") this.classes = null;
		this.ownerDocument.cmd(Op.removeAttribute).u32(this.id);
		this.ownerDocument.buf.str(n);
	}
	toggleAttribute(name: string, force?: boolean): boolean {
		const on = force ?? !this.hasAttribute(name);
		if (on) this.setAttribute(name, "");
		else this.removeAttribute(name);
		return on;
	}

	get id_(): string {
		return this.getAttribute("id") ?? "";
	}
	get className(): string {
		return this.getAttribute("class") ?? "";
	}
	set className(v: string) {
		if (v) this.setAttribute("class", v);
		else this.removeAttribute("class");
	}
	get classList() {
		const self = this;
		const set = () => {
			if (!self.classes) self.classes = new Set(self.className.split(/\s+/).filter(Boolean));
			return self.classes;
		};
		const commit = () => self.setAttribute("class", Array.from(set()).join(" "));
		return {
			add(...names: string[]) {
				names.forEach((n) => set().add(n));
				commit();
			},
			remove(...names: string[]) {
				names.forEach((n) => set().delete(n));
				commit();
			},
			contains(n: string) {
				return set().has(n);
			},
			toggle(n: string, force?: boolean) {
				const s = set();
				const on = force ?? !s.has(n);
				if (on === s.has(n)) return on;
				if (on) s.add(n);
				else s.delete(n);
				commit();
				return on;
			},
		};
	}
	get style(): Record<string, any> {
		if (!this._style) this._style = createStyle(this);
		return this._style;
	}

	// ---- form control properties ----
	get value(): string {
		if (this.localName === "option") return this.getAttribute("value") ?? this.textContent;
		return this.ownerDocument.readValue(this);
	}
	set value(v: string) {
		// <option>.value reflects its attribute, which <select> reads
		if (this.localName === "option") {
			this.setAttribute("value", String(v ?? ""));
			return;
		}
		const s = v == null ? "" : String(v);
		// A controlled input echoes each input event's value back. Events are
		// handled after the fact, so by then the user may have typed more:
		// writing the echo would undo those keystrokes. The engine already
		// holds the value it last reported (or that was last set), so skip it.
		if (this.ownerDocument.valueCache.get(this.id) === s) return;
		this.ownerDocument.cmd(Op.setValue).u32(this.id);
		this.ownerDocument.buf.str(s);
		this.ownerDocument.valueCache.set(this.id, s);
	}
	get checked(): boolean {
		return this.ownerDocument.readChecked(this);
	}
	set checked(on: boolean) {
		if (on) this.setAttribute("checked", "");
		else this.removeAttribute("checked");
	}
	set selected(on: boolean) {
		this.toggleAttribute("selected", !!on);
	}
	get selected(): boolean {
		return this.hasAttribute("selected");
	}
	set disabled(on: boolean) {
		this.toggleAttribute("disabled", !!on);
	}
	get disabled(): boolean {
		return this.hasAttribute("disabled");
	}
	set innerHTML(html: string) {
		this.textContent = "";
		this.ownerDocument.appendHtml(this, html);
	}

	focus(): void {
		this.ownerDocument.cmd(Op.focus).u32(this.id);
	}
	blur(): void {
		this.ownerDocument.cmd(Op.focus).u32(0);
	}
	scrollIntoView(): void {
		this.ownerDocument.scrollIntoView(this);
	}
	getBoundingClientRect() {
		return this.ownerDocument.rectOf(this);
	}

	// ---- events ----
	addEventListener(type: string, fn: Listener | { handleEvent: Listener }): void {
		const name = type.toLowerCase();
		let set = this.listeners.get(name);
		if (!set) {
			set = new Set();
			this.listeners.set(name, set);
			this.ownerDocument.listen(this, name);
		}
		set.add(typeof fn === "function" ? fn : fn.handleEvent.bind(fn));
	}
	removeEventListener(type: string, fn: Listener): void {
		const set = this.listeners.get(type.toLowerCase());
		set?.delete(fn);
	}
	/** internal */
	fire(type: string, ev: NativeEvent): void {
		const set = this.listeners.get(type);
		if (!set) return;
		for (const fn of Array.from(set)) {
			try {
				fn(ev);
			} catch (err) {
				console.error(err);
			}
		}
	}
}

export interface NativeEvent {
	type: string;
	target: NativeElement | null;
	currentTarget: NativeElement | null;
	clientX: number;
	clientY: number;
	x: number;
	y: number;
	button: number;
	detail: number;
	key: string;
	shiftKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	metaKey: boolean;
	deltaX: number;
	deltaY: number;
	data: string;
	defaultPrevented: boolean;
	preventDefault(): void;
	stopPropagation(): void;
}

const EVENT_NAMES = [
	"pointerdown", "pointerup", "pointermove", "pointerenter", "pointerleave", "pointerover", "pointerout",
	"click", "dblclick", "contextmenu", "wheel", "scroll", "keydown", "keyup", "input", "change", "focus",
	"blur", "focusin", "focusout", "submit", "toggle", "beforeinput", "compositionstart", "compositionupdate",
	"compositionend", "resize",
];
const EVENT_ALIASES: Record<string, string> = {
	mousedown: "pointerdown",
	mouseup: "pointerup",
	mousemove: "pointermove",
	mouseenter: "pointerenter",
	mouseleave: "pointerleave",
	mouseover: "pointerover",
	mouseout: "pointerout",
};

export class NativeDocument {
	readonly buf = new CommandBuffer();
	readonly body: NativeElement;
	readonly documentElement: NativeElement;
	readonly valueCache = new Map<number, string>();
	private nextId = 2;
	private scheduled = false;
	/** nodes that can receive events (strongly held) */
	private listening = new Map<number, NativeElement>();
	private stopped = new Set<number>();
	private pollBuf = new Uint8Array(1 << 16);
	private finalizer = new FinalizationRegistry<number>((id) => {
		this.cmd(Op.destroy).u32(id);
	});
	private disposed = false;

	constructor(readonly ui: number) {
		this.body = new NativeElement(this, 1, "body", null);
		this.documentElement = this.body;
		uiLib().ebui_bind_client_id(ui, 1, uiLib().ebui_body(ui));
	}

	/** Start a command and schedule a flush at the end of this microtask. */
	cmd(op: Op): CommandBuffer {
		this.buf.u8(op);
		if (!this.scheduled) {
			this.scheduled = true;
			queueMicrotask(() => this.flush());
		}
		return this.buf;
	}

	flush(): void {
		this.scheduled = false;
		if (this.buf.len === 0 || this.disposed) return;
		uiLib().ebui_apply(this.ui, ptr(this.buf.bytes), this.buf.len);
		this.buf.len = 0;
	}

	createElement(tag: string): NativeElement {
		const id = this.nextId++;
		this.cmd(Op.createElement).u32(id);
		this.buf.str(tag);
		const el = new NativeElement(this, id, tag, null);
		this.finalizer.register(el, id, el);
		return el;
	}
	createElementNS(ns: string, tag: string): NativeElement {
		const id = this.nextId++;
		this.cmd(Op.createElement).u32(id);
		this.buf.str(tag);
		const el = new NativeElement(this, id, tag, ns);
		this.finalizer.register(el, id, el);
		return el;
	}
	createTextNode(data: string): NativeText {
		const id = this.nextId++;
		this.cmd(Op.createText).u32(id);
		this.buf.str(data);
		const t = new NativeText(this, id, data);
		this.finalizer.register(t, id, t);
		return t;
	}
	createComment(data = ""): NativeComment {
		const id = this.nextId++;
		this.cmd(Op.createComment).u32(id);
		const c = new NativeComment(this, id, data);
		this.finalizer.register(c, id, c);
		return c;
	}

	/** internal hooks from the node mirror */
	attached(_node: NativeNode): void {}
	detached(_node: NativeNode): void {}

	private eventType(name: string): number {
		const n = EVENT_ALIASES[name] ?? name;
		return EVENT_NAMES.indexOf(n);
	}

	listen(el: NativeElement, name: string): void {
		const t = this.eventType(name);
		if (t < 0) return;
		this.listening.set(el.id, el);
		this.cmd(Op.listen).u32(el.id);
		this.buf.u8(t);
	}

	readValue(el: NativeElement): string {
		this.flush();
		const lib = uiLib();
		const core = lib.ebui_resolve(this.ui, el.id);
		const lenBuf = new BigUint64Array(1);
		const p = lib.ebui_get_value(this.ui, core, ptr(lenBuf));
		const len = Number(lenBuf[0]);
		if (!p || len === 0) return "";
		return dec.decode(new Uint8Array(toArrayBuffer(p, 0, len)));
	}
	readChecked(el: NativeElement): boolean {
		this.flush();
		const lib = uiLib();
		return lib.ebui_get_checked(this.ui, lib.ebui_resolve(this.ui, el.id));
	}
	rectOf(el: NativeElement) {
		this.flush();
		const lib = uiLib();
		const out = new Float32Array(4);
		lib.ebui_get_rect(this.ui, lib.ebui_resolve(this.ui, el.id), ptr(out));
		const x = out[0]!;
		const y = out[1]!;
		const width = out[2]!;
		const height = out[3]!;
		return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
	}
	scrollIntoView(el: NativeElement): void {
		this.flush();
		const lib = uiLib();
		lib.ebui_scroll_into_view(this.ui, lib.ebui_resolve(this.ui, el.id));
	}
	appendHtml(el: NativeElement, html: string): void {
		this.flush();
		const lib = uiLib();
		const [p, n] = strArgs(html);
		lib.ebui_append_html(this.ui, lib.ebui_resolve(this.ui, el.id), p, n);
	}

	/** Drain queued native events and dispatch them to listeners. */
	pump(): void {
		if (this.disposed) return;
		this.flush();
		const lib = uiLib();
		const pending = Number(lib.ebui_pending_events(this.ui));
		if (pending === 0) return;
		if (pending > this.pollBuf.length) this.pollBuf = new Uint8Array(pending * 2);
		const n = Number(lib.ebui_poll_events(this.ui, ptr(this.pollBuf), this.pollBuf.length));
		const view = new DataView(this.pollBuf.buffer, 0, n);
		let o = 0;
		const str = () => {
			const len = view.getUint32(o, true);
			o += 4;
			const s = dec.decode(this.pollBuf.subarray(o, o + len));
			o += len;
			return s;
		};
		this.stopped.clear();
		while (o < n) {
			const kind = view.getUint8(o++);
			if (kind === 1) {
				const type = EVENT_NAMES[view.getUint8(o++)] ?? "unknown";
				const serial = view.getUint32(o, true);
				const target = view.getUint32(o + 4, true);
				const current = view.getUint32(o + 8, true);
				o += 16; // + target core id
				const x = view.getFloat32(o, true);
				const y = view.getFloat32(o + 4, true);
				const button = view.getUint8(o + 8);
				const mods = view.getUint8(o + 9);
				const detail = view.getUint32(o + 10, true);
				const dx = view.getFloat32(o + 14, true);
				const dy = view.getFloat32(o + 18, true);
				o += 22;
				const key = str();
				const data = str();
				const cur = this.listening.get(current) ?? null;
				if (!cur || this.stopped.has(serial)) continue;
				if (type === "input" || type === "change") this.valueCache.set(current, data);
				const doc = this;
				const ev: NativeEvent = {
					type,
					target: this.listening.get(target) ?? cur,
					currentTarget: cur,
					clientX: x,
					clientY: y,
					x,
					y,
					button,
					detail,
					key,
					shiftKey: (mods & 1) !== 0,
					ctrlKey: (mods & 2) !== 0,
					altKey: (mods & 4) !== 0,
					metaKey: (mods & 8) !== 0,
					deltaX: dx,
					deltaY: dy,
					data,
					defaultPrevented: false,
					preventDefault() {
						this.defaultPrevented = true;
					},
					stopPropagation() {
						doc.stopped.add(serial);
					},
				};
				// keyboard names follow the DOM
				cur.fire(type, ev);
				const alias = Object.entries(EVENT_ALIASES).find(([, v]) => v === type)?.[0];
				if (alias) cur.fire(alias, ev);
			} else if (kind === 2) {
				// template handler call: name, scope, args, event
				const name = str();
				o += 4;
				const argc = view.getUint8(o++);
				const args: unknown[] = [];
				for (let i = 0; i < argc; i++) {
					const tag = view.getUint8(o++);
					if (tag === 0) args.push(null);
					else if (tag === 1) args.push(view.getUint8(o++) !== 0);
					else if (tag === 2) {
						args.push(view.getFloat64(o, true));
						o += 8;
					} else if (tag === 3) args.push(str());
					else {
						args.push(view.getUint32(o, true));
						o += 4;
					}
				}
				o += 5;
				this.onHandler?.(name, args);
			} else if (kind === 3) {
				// watched element rect changed: client, x, y, w, h, visible
				const client = view.getUint32(o, true);
				const rect: UIRect = {
					x: view.getFloat32(o + 4, true),
					y: view.getFloat32(o + 8, true),
					width: view.getFloat32(o + 12, true),
					height: view.getFloat32(o + 16, true),
					visible: view.getUint8(o + 20) !== 0,
				};
				o += 21;
				for (const fn of this.rectWatchers.get(client) ?? []) fn(rect);
			} else break;
		}
	}

	onHandler: ((name: string, args: unknown[]) => void) | null = null;

	private rectWatchers = new Map<number, Set<(rect: UIRect) => void>>();

	/**
	 * Call `fn` with the element's window rect after every frame in which it
	 * changed (layout, scroll, resize) and when it is hidden or removed. Any
	 * number of watchers may observe one element; each gets the current rect
	 * on the next frame. Returns a function that stops watching.
	 */
	watchRect(el: NativeElement, fn: (rect: UIRect) => void): () => void {
		this.flush();
		const lib = uiLib();
		const core = lib.ebui_resolve(this.ui, el.id);
		// (re)registering resets the core's last-reported rect, so every
		// watcher - including this new one - hears the current rect
		if (!core || !lib.ebui_watch_rect(this.ui, core, true)) throw new Error("watchRect: element is not in the document");
		let set = this.rectWatchers.get(el.id);
		if (!set) this.rectWatchers.set(el.id, (set = new Set()));
		set.add(fn);
		return () => {
			const cur = this.rectWatchers.get(el.id);
			if (!cur?.delete(fn) || cur.size > 0) return;
			this.rectWatchers.delete(el.id);
			if (!this.disposed) lib.ebui_watch_rect(this.ui, lib.ebui_resolve(this.ui, el.id), false);
		};
	}

	dispose(): void {
		this.flush();
		this.disposed = true;
	}
}
