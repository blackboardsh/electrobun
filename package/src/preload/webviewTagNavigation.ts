export type WebviewTagNavigation =
	| { kind: "url"; value: string }
	| { kind: "html"; value: string };

/**
 * Keeps only the latest navigation requested while a webview tag is being
 * created. The initialization request already contains the attributes that
 * existed when it started, so those older requests must not be replayed.
 */
export class WebviewTagNavigationQueue {
	private pending: WebviewTagNavigation | null = null;

	beginInitialization() {
		this.pending = null;
	}

	defer(navigation: WebviewTagNavigation) {
		this.pending = navigation;
	}

	take(): WebviewTagNavigation | null {
		const navigation = this.pending;
		this.pending = null;
		return navigation;
	}
}
