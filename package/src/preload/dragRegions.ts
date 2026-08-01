// Drag region support for custom titlebars.

import "./globals.d.ts";
import { send } from "./internalRpc";

const DRAG_CLASS = "electrobun-webkit-app-region-drag";
const NO_DRAG_CLASS = "electrobun-webkit-app-region-no-drag";
const MIRRORED_PROPERTY = "--electrobun-app-region";
const MIRROR_ATTRIBUTE = "data-electrobun-app-region-mirror";
const APP_REGION_PROPERTIES = [
	MIRRORED_PROPERTY,
	"-webkit-app-region",
	"app-region",
	"window-drag",
] as const;

type AppRegion = "drag" | "no-drag" | null;
type ComputedStyleReader = (
	element: Element,
) => Pick<CSSStyleDeclaration, "getPropertyValue">;
type DragRegionSender = (type: string, payload: unknown) => void;
type RuleContainer = {
	cssRules: CSSRuleList;
	deleteRule(index: number): void;
};

const processedSourceSignatures = new WeakMap<Element, string>();
const stylesheetMirrors = new Map<Element, HTMLStyleElement>();
const pendingLinkSignatures = new WeakMap<HTMLLinkElement, string>();
let stylesheetMirroringInitialized = false;

function normalizedRegion(value: string | null | undefined): AppRegion {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "drag" || normalized === "no-drag") return normalized;
	return null;
}

function previousSignificantCharacter(source: string, offset: number): string {
	let index = offset - 1;
	while (index >= 0) {
		while (index >= 0 && /\s/.test(source[index] ?? "")) index--;
		if (index >= 1 && source[index] === "/" && source[index - 1] === "*") {
			const commentStart = source.lastIndexOf("/*", index - 1);
			if (commentStart < 0) return "";
			index = commentStart - 1;
			continue;
		}
		return source[index] ?? "";
	}
	return "";
}

function isIdentifierCharacter(character: string | undefined): boolean {
	return !!character && /[a-zA-Z0-9_-]/.test(character);
}

/**
 * Rewrites only app-region declaration names. WKWebView drops the unsupported
 * property from CSSOM, while custom properties survive and retain CSS cascade.
 */
export function rewriteAppRegionDeclarations(source: string): string {
	const propertyNames = ["-webkit-app-region", "window-drag", "app-region"];
	let output = "";
	let cursor = 0;
	let index = 0;

	while (index < source.length) {
		if (source[index] === "/" && source[index + 1] === "*") {
			const commentEnd = source.indexOf("*/", index + 2);
			index = commentEnd < 0 ? source.length : commentEnd + 2;
			continue;
		}

		if (source[index] === '"' || source[index] === "'") {
			const quote = source[index];
			index++;
			while (index < source.length) {
				if (source[index] === "\\") {
					index += 2;
					continue;
				}
				if (source[index] === quote) {
					index++;
					break;
				}
				index++;
			}
			continue;
		}

		let matchedProperty: string | undefined;
		for (const propertyName of propertyNames) {
			if (
				source.slice(index, index + propertyName.length).toLowerCase() ===
					propertyName &&
				!isIdentifierCharacter(source[index - 1]) &&
				!isIdentifierCharacter(source[index + propertyName.length])
			) {
				matchedProperty = propertyName;
				break;
			}
		}

		if (matchedProperty) {
			let colonOffset = index + matchedProperty.length;
			while (/\s/.test(source[colonOffset] ?? "")) colonOffset++;
			const previous = previousSignificantCharacter(source, index);
			if (source[colonOffset] === ":" && (previous === "{" || previous === ";")) {
				output += source.slice(cursor, index) + MIRRORED_PROPERTY;
				index += matchedProperty.length;
				cursor = index;
				continue;
			}
		}

		index++;
	}

	return output + source.slice(cursor);
}

function nestedRuleContainer(rule: CSSRule): RuleContainer | null {
	const candidate = rule as CSSRule & Partial<RuleContainer>;
	if (candidate.cssRules && typeof candidate.deleteRule === "function") {
		return candidate as CSSRule & RuleContainer;
	}
	return null;
}

function pruneToAppRegionRules(container: RuleContainer): boolean {
	let hasAppRegionRule = false;

	for (let index = container.cssRules.length - 1; index >= 0; index--) {
		const rule = container.cssRules[index];
		if (!rule) continue;

		const style = (rule as CSSStyleRule).style;
		let hasAppRegionDeclaration = false;
		if (style && typeof style.getPropertyValue === "function") {
			for (let propertyIndex = style.length - 1; propertyIndex >= 0; propertyIndex--) {
				const propertyName = style.item(propertyIndex);
				if (propertyName === MIRRORED_PROPERTY) {
					hasAppRegionDeclaration = true;
				} else {
					style.removeProperty(propertyName);
				}
			}
		}

		const nested = nestedRuleContainer(rule);
		const hasNestedAppRegionRule = nested ? pruneToAppRegionRules(nested) : false;
		if (!hasAppRegionDeclaration && !hasNestedAppRegionRule) {
			container.deleteRule(index);
			continue;
		}

		hasAppRegionRule = true;
	}

	return hasAppRegionRule;
}

function serializeRules(rules: CSSRuleList): string {
	let cssText = "";
	for (let index = 0; index < rules.length; index++) {
		const rule = rules[index];
		if (rule) cssText += `${rule.cssText}\n`;
	}
	return cssText;
}

function removeStylesheetMirror(source: Element) {
	stylesheetMirrors.get(source)?.remove();
	stylesheetMirrors.delete(source);
}

function installStylesheetMirror(
	source: HTMLStyleElement | HTMLLinkElement,
	cssText: string,
	signature: string,
) {
	if (processedSourceSignatures.get(source) === signature) return;
	processedSourceSignatures.set(source, signature);
	removeStylesheetMirror(source);

	const mirroredCss = rewriteAppRegionDeclarations(cssText);
	if (mirroredCss === cssText || !source.parentNode) return;

	const mirror = source.ownerDocument.createElement("style");
	mirror.setAttribute(MIRROR_ATTRIBUTE, "");
	mirror.media = "not all";
	if (source.nonce) mirror.nonce = source.nonce;
	mirror.textContent = mirroredCss;
	source.parentNode.insertBefore(mirror, source.nextSibling);

	let sheet = mirror.sheet;
	if (!sheet || !pruneToAppRegionRules(sheet)) {
		mirror.remove();
		return;
	}

	// CSSOM mutation does not update the style element's text node. Re-serialize
	// so the mirror retains only the small set of app-region rules in memory.
	mirror.textContent = serializeRules(sheet.cssRules);
	sheet = mirror.sheet;
	if (!sheet) {
		mirror.remove();
		return;
	}

	mirror.media = source.media;
	if (source.sheet?.disabled) sheet.disabled = true;
	stylesheetMirrors.set(source, mirror);
}

function isMirroredStyle(element: Element): boolean {
	return element.tagName === "STYLE" && element.hasAttribute(MIRROR_ATTRIBUTE);
}

function isStylesheetSource(element: Element): boolean {
	if (element.tagName === "STYLE") return !isMirroredStyle(element);
	return (
		element.tagName === "LINK" &&
		(element as HTMLLinkElement).relList.contains("stylesheet")
	);
}

function nodeContainsStylesheetSource(node: Node): boolean {
	const element = node as Element;
	if (typeof element.matches !== "function") return false;
	return (
		isStylesheetSource(element) ||
		!!element.querySelector(
			"style:not([data-electrobun-app-region-mirror]), link[rel~='stylesheet']",
		)
	);
}

function mutationsAffectStylesheets(mutations: MutationRecord[]): boolean {
	for (const mutation of mutations) {
		if (mutation.type === "attributes") {
			const element = mutation.target as Element;
			if (element.tagName === "LINK" || isStylesheetSource(element)) return true;
			continue;
		}

		if (mutation.type === "characterData") {
			const parent = mutation.target.parentElement;
			if (parent && isStylesheetSource(parent)) return true;
			continue;
		}

		const target = mutation.target as Element;
		if (typeof target.matches === "function" && isStylesheetSource(target)) {
			return true;
		}
		for (let index = 0; index < mutation.addedNodes.length; index++) {
			const node = mutation.addedNodes[index];
			if (node && nodeContainsStylesheetSource(node)) return true;
		}
		for (let index = 0; index < mutation.removedNodes.length; index++) {
			const node = mutation.removedNodes[index];
			if (node && nodeContainsStylesheetSource(node)) return true;
		}
	}
	return false;
}

function processStyleElement(style: HTMLStyleElement) {
	if (isMirroredStyle(style)) return;
	const cssText = style.textContent ?? "";
	installStylesheetMirror(style, cssText, `${style.media}\n${cssText}`);
}

function processLinkElement(link: HTMLLinkElement) {
	if (!link.relList.contains("stylesheet") || !link.href) {
		removeStylesheetMirror(link);
		return;
	}

	const signature = `${link.media}\n${link.href}`;
	if (
		processedSourceSignatures.get(link) === signature ||
		pendingLinkSignatures.get(link) === signature
	) {
		return;
	}

	pendingLinkSignatures.set(link, signature);
	fetch(link.href, { credentials: "same-origin" })
		.then((response) => {
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return response.text();
		})
		.then((cssText) => {
			if (link.isConnected && `${link.media}\n${link.href}` === signature) {
				installStylesheetMirror(link, cssText, signature);
			}
		})
		.catch(() => {
			// Cross-origin stylesheets may not be readable. Chromium/WebView2 can
			// still expose its native app-region value through computed style.
		})
		.finally(() => {
			if (pendingLinkSignatures.get(link) === signature) {
				pendingLinkSignatures.delete(link);
			}
		});
}

function scanStylesheetSources() {
	document
		.querySelectorAll("style, link[rel~='stylesheet']")
		.forEach((element) => {
			if (element.tagName === "STYLE") {
				processStyleElement(element as HTMLStyleElement);
			} else {
				processLinkElement(element as HTMLLinkElement);
			}
		});

	for (const [source, mirror] of stylesheetMirrors) {
		if (!source.isConnected) {
			mirror.remove();
			stylesheetMirrors.delete(source);
		}
	}
}

function initStylesheetMirroring() {
	if (stylesheetMirroringInitialized) return;
	stylesheetMirroringInitialized = true;

	let scanScheduled = false;
	const scheduleScan = () => {
		if (scanScheduled) return;
		scanScheduled = true;
		queueMicrotask(() => {
			scanScheduled = false;
			scanStylesheetSources();
		});
	};

	new MutationObserver((mutations) => {
		if (mutationsAffectStylesheets(mutations)) scheduleScan();
	}).observe(document, {
		attributes: true,
		attributeFilter: ["href", "media", "rel"],
		characterData: true,
		childList: true,
		subtree: true,
	});
	document.addEventListener("DOMContentLoaded", scheduleScan, { once: true });
	scheduleScan();
}

function inlineRegion(element: Element): AppRegion {
	const style = element.getAttribute?.("style");
	if (!style) return null;
	const match = style.match(
		/(?:^|;)\s*(?:-webkit-app-region|app-region|window-drag)\s*:\s*(no-drag|drag)\b/i,
	);
	return normalizedRegion(match?.[1]);
}

function computedRegion(
	element: Element,
	readComputedStyle: ComputedStyleReader,
): AppRegion {
	try {
		const style = readComputedStyle(element);
		for (const propertyName of APP_REGION_PROPERTIES) {
			const region = normalizedRegion(style.getPropertyValue(propertyName));
			if (region) return region;
		}
	} catch {
		// Detached or synthetic elements may not have a computed style.
	}
	return null;
}

function eventTargetElement(target: EventTarget | null): Element | null {
	if (!target || typeof (target as Element).getAttribute !== "function") {
		return (target as Node | null)?.parentElement ?? null;
	}
	return target as Element;
}

export function isAppRegionDragTarget(
	target: EventTarget | null,
	readComputedStyle: ComputedStyleReader = (element) =>
		window.getComputedStyle(element),
): boolean {
	let element = eventTargetElement(target);
	let foundDragRegion = false;

	while (element) {
		if (element.classList?.contains(NO_DRAG_CLASS)) return false;
		if (element.classList?.contains(DRAG_CLASS)) foundDragRegion = true;

		const region =
			inlineRegion(element) ?? computedRegion(element, readComputedStyle);
		if (region === "no-drag") return false;
		if (region === "drag") foundDragRegion = true;

		element = element.parentElement;
	}

	return foundDragRegion;
}

export function registerDragRegionListeners(
	targetDocument: Document,
	getWindowId: () => number,
	sendMessage: DragRegionSender = send,
	readComputedStyle: ComputedStyleReader = (element) =>
		window.getComputedStyle(element),
) {
	targetDocument.addEventListener("mousedown", (event) => {
		if (isAppRegionDragTarget(event.target, readComputedStyle)) {
			sendMessage("startWindowMove", { id: getWindowId() });
		}
	});

	targetDocument.addEventListener("mouseup", (event) => {
		if (isAppRegionDragTarget(event.target, readComputedStyle)) {
			sendMessage("stopWindowMove", { id: getWindowId() });
		}
	});
}

export function initDragRegions() {
	initStylesheetMirroring();
	registerDragRegionListeners(document, () => window.__electrobunWindowId);
}
