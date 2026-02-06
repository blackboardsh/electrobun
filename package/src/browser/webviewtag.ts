import "./global.d.ts";

type WebviewEventTypes =
	| "did-navigate"
	| "did-navigate-in-page"
	| "did-commit-navigation"
	| "dom-ready"
	| "host-message"
	| "new-window-open";

/**
 * Interface representing an <electrobun-webview> custom element.
 * Use this to properly type webview elements obtained via querySelector.
 *
 * @example
 * const webview = document.querySelector('electrobun-webview') as WebviewTagElement;
 * webview.loadURL('https://example.com');
 * webview.toggleHidden(false);
 */
interface WebviewTagElement extends HTMLElement {
	// Properties
	webviewId?: number;
	maskSelectors: Set<string>;
	transparent: boolean;
	passthroughEnabled: boolean;
	hidden: boolean;
	hiddenMirrorMode: boolean;
	partition: string | null;

	// Attribute-backed properties (getters/setters)
	src: string | null;
	html: string | null;
	preload: string | null;
	renderer: "cef" | "native";

	// Mask management
	addMaskSelector(selector: string): void;
	removeMaskSelector(selector: string): void;

	// Navigation
	canGoBack(): Promise<boolean>;
	canGoForward(): Promise<boolean>;
	goBack(): void;
	goForward(): void;
	reload(): void;
	loadURL(url: string): void;
	loadHTML(html: string): void;

	// Visibility and interaction
	toggleTransparent(transparent?: boolean, bypassState?: boolean): void;
	togglePassthrough(enablePassthrough?: boolean, bypassState?: boolean): void;
	toggleHidden(hidden?: boolean, bypassState?: boolean): void;

	// Events - listener receives a CustomEvent with detail property
	on(event: WebviewEventTypes, listener: (event: CustomEvent) => void): void;
	off(event: WebviewEventTypes, listener: (event: CustomEvent) => void): void;
	emit(event: WebviewEventTypes, detail: unknown): void;

	// Dimension sync
	syncDimensions(force?: boolean): void;

	// Navigation rules
	setNavigationRules(rules: string[]): void;

	// Find in page
	findInPage(
		searchText: string,
		options?: { forward?: boolean; matchCase?: boolean },
	): void;
	stopFindInPage(): void;

	// Developer tools
	openDevTools(): void;
	closeDevTools(): void;
	toggleDevTools(): void;
}

// Augment global types so querySelector('electrobun-webview') returns WebviewTagElement
declare global {
	interface HTMLElementTagNameMap {
		"electrobun-webview": WebviewTagElement;
	}
}

export { type WebviewTagElement, type WebviewEventTypes };
