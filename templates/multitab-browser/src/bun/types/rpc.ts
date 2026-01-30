import type { RPCSchema } from "electrobun/bun";

export type Tab = {
	id: string;
	title: string;
	url: string;
	canGoBack: boolean;
	canGoForward: boolean;
	isLoading: boolean;
	favicon?: string;
};

export type Bookmark = {
	id: string;
	title: string;
	url: string;
	createdAt: number;
};

export type BrowserRPC = {
	bun: RPCSchema<{
		requests: {
			createTab: {
				params: { url?: string };
				response: Tab;
			};
			closeTab: {
				params: { id: string };
				response: void;
			};
			navigateTo: {
				params: { tabId: string; url: string };
				response: void;
			};
			goBack: {
				params: { tabId: string };
				response: void;
			};
			goForward: {
				params: { tabId: string };
				response: void;
			};
			reload: {
				params: { tabId: string };
				response: void;
			};
			getTabInfo: {
				params: { tabId: string };
				response: Tab;
			};
			getAllTabs: {
				params: {};
				response: Tab[];
			};
			addBookmark: {
				params: { title: string; url: string };
				response: Bookmark;
			};
			getBookmarks: {
				params: {};
				response: Bookmark[];
			};
			removeBookmark: {
				params: { id: string };
				response: void;
			};
		};
		messages: {
			tabUpdated: Tab;
			tabClosed: { id: string };
			loadingStateChanged: { tabId: string; isLoading: boolean };
		};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {};
	}>;
};
