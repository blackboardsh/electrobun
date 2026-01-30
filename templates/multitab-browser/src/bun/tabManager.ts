import { BrowserView } from "electrobun/bun";
import { type Tab, type Bookmark } from "./types/rpc";

export class TabManager {
	private tabs: Map<string, Tab> = new Map();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private webviews: Map<string, BrowserView<any>> = new Map();
	private bookmarks: Map<string, Bookmark> = new Map();
	private nextTabId = 1;

	public onTabUpdate?: (tab: Tab) => void;
	public onLoadingStateChange?: (tabId: string, isLoading: boolean) => void;

	constructor() {
		// Load bookmarks from storage if available
		this.loadBookmarks();
	}

	async createTab(url: string): Promise<Tab> {
		const id = `tab-${this.nextTabId++}`;

		// Create a BrowserView for this tab
		const webview = new BrowserView({
			url,
			frame: {
				x: 0,
				y: 100, // Leave space for tab bar and navigation
				width: 1400,
				height: 800,
			},
		});

		// Set up webview event handlers
		// Note: Some of these events may not be supported yet
		(webview as any).on("page-title-updated", (event: any) => {
			const tab = this.tabs.get(id);
			if (tab) {
				tab.title = event.data?.title || "New Tab";
				this.onTabUpdate?.(tab);
			}
		});

		(webview as any).on("did-start-loading", () => {
			const tab = this.tabs.get(id);
			if (tab) {
				tab.isLoading = true;
				this.onLoadingStateChange?.(id, true);
			}
		});

		(webview as any).on("did-stop-loading", () => {
			const tab = this.tabs.get(id);
			if (tab) {
				tab.isLoading = false;
				this.onLoadingStateChange?.(id, false);
			}
		});

		webview.on("did-navigate", (event: any) => {
			const tab = this.tabs.get(id);
			if (tab && event.data.url) {
				tab.url = event.data.url;
				// Update navigation state
				this.updateNavigationState(id);
				this.onTabUpdate?.(tab);
			}
		});

		const tab: Tab = {
			id,
			title: "New Tab",
			url,
			canGoBack: false,
			canGoForward: false,
			isLoading: true,
		};

		this.tabs.set(id, tab);
		this.webviews.set(id, webview);

		return tab;
	}

	async closeTab(id: string): Promise<void> {
		const webview = this.webviews.get(id);
		if (webview) {
			(webview as any).destroy();
			this.webviews.delete(id);
		}
		this.tabs.delete(id);
	}

	async navigateTo(tabId: string, url: string): Promise<void> {
		const webview = this.webviews.get(tabId);
		if (webview) {
			// Ensure URL has protocol
			if (!url.startsWith("http://") && !url.startsWith("https://")) {
				// Check if it looks like a domain
				if (url.includes(".") && !url.includes(" ")) {
					url = `https://${url}`;
				} else {
					// Treat as search query
					url = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
				}
			}

			await webview.loadURL(url);
			const tab = this.tabs.get(tabId);
			if (tab) {
				tab.url = url;
				tab.isLoading = true;
				this.onTabUpdate?.(tab);
			}
		}
	}

	async goBack(tabId: string): Promise<void> {
		const webview = this.webviews.get(tabId);
		if (webview) {
			await (webview as any).goBack();
			this.updateNavigationState(tabId);
		}
	}

	async goForward(tabId: string): Promise<void> {
		const webview = this.webviews.get(tabId);
		if (webview) {
			await (webview as any).goForward();
			this.updateNavigationState(tabId);
		}
	}

	async reload(tabId: string): Promise<void> {
		const webview = this.webviews.get(tabId);
		if (webview) {
			await (webview as any).reload();
			const tab = this.tabs.get(tabId);
			if (tab) {
				tab.isLoading = true;
				this.onTabUpdate?.(tab);
			}
		}
	}

	async getTabInfo(tabId: string): Promise<Tab | undefined> {
		return this.tabs.get(tabId);
	}

	getAllTabs(): Tab[] {
		return Array.from(this.tabs.values());
	}

	private async updateNavigationState(tabId: string): Promise<void> {
		const webview = this.webviews.get(tabId);
		const tab = this.tabs.get(tabId);

		if (webview && tab) {
			// Note: These methods might not be available in current Electrobun API
			// This is a placeholder for navigation state management
			tab.canGoBack = false; // Would need webview.canGoBack()
			tab.canGoForward = false; // Would need webview.canGoForward()
		}
	}

	// Bookmark management
	addBookmark(title: string, url: string): Bookmark {
		const id = `bookmark-${Date.now()}`;
		const bookmark: Bookmark = {
			id,
			title,
			url,
			createdAt: Date.now(),
		};

		this.bookmarks.set(id, bookmark);
		this.saveBookmarks();
		return bookmark;
	}

	getBookmarks(): Bookmark[] {
		return Array.from(this.bookmarks.values()).sort(
			(a, b) => b.createdAt - a.createdAt,
		);
	}

	removeBookmark(id: string): void {
		this.bookmarks.delete(id);
		this.saveBookmarks();
	}

	private loadBookmarks(): void {
		// In a real app, load from persistent storage
		// For demo, we'll start with some default bookmarks
		this.addBookmark("Google", "https://www.google.com");
		this.addBookmark("GitHub", "https://github.com");
		this.addBookmark("Electrobun", "https://electrobun.dev");
	}

	private saveBookmarks(): void {
		// In a real app, save to persistent storage
		// For demo, we'll just log
		console.log("Bookmarks saved:", this.getBookmarks());
	}
}
