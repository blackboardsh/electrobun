// YYY - DidNAvigateEvent types
// import { DidNavigateEvent, DidNavigateInPageEvent } from "electron";
type DidNavigateEvent = any;
type DidNavigateInPageEvent = any;
import {
	type AppState,
	type WebTabType,
	focusTabWithId,
	updateSyncedState,
	openNewTabForNode,
	getCurrentPane,
	getPaneWithId,
	setNodeExpanded,
} from "../store";
import type {
	CachedFileType,
	PreviewFileTreeType,
} from "../../../shared/types/types";
import { state, setState } from "../store";
import { produce } from "solid-js/store";
import { electrobun as electrobunImport } from "../init";
import { getWindow } from "../store";

import { getSlateForNode, getProjectForNodePath } from "../files";

import { type DomEventWithTarget } from "../../../shared/types/types";
import { Show, createEffect, createSignal, createMemo } from "solid-js";
import { electrobun } from "../init";

import { join } from "../../utils/pathUtils";
import { getNode } from "../FileWatcher";
import { createBrowserProfileFolderName } from "../../utils/browserProfileUtils";

// Give the window layout 1 second to settle (sidebar animation, pane sizing, etc.)
// before revealing any web slates. All WebSlate instances share this signal so
// tabs opened after startup are not delayed.
const [windowStartupSettled, setWindowStartupSettled] = createSignal(false);
setTimeout(() => setWindowStartupSettled(true), 1000);

// Not needed anymore - using regex pattern instead
// const hasValidProtocol = (url: string) => {
//   return (
//     url.startsWith("http://") ||
//     url.startsWith("https://") ||
//     url.startsWith("file://")
//   );
// };

// todo: implement cmd + click to open in new tab. needs more thought
const bunnyPreloadScript = `
(function() {
  // Notify host that the page loaded successfully (preload script executed)
  if (typeof window.__electrobunSendToHost === 'function') {
    window.__electrobunSendToHost({
      type: 'bunny:page-loaded'
    });
  }

  // Set a default background color for pages that don't specify one
  // (e.g., raw JS/text files served without HTML)
  document.documentElement.style.backgroundColor = '#1e1e1e';

  // Forward certain keyboard shortcuts to the host so they work
  // even when the webview OOPIF has focus
  document.addEventListener('keydown', function(e) {
    var shouldForward = false;

    // Ctrl+Tab / Ctrl+Shift+Tab - tab cycling
    if (e.key === 'Tab' && e.ctrlKey) {
      shouldForward = true;
    }
    // Cmd+F - find in page
    if (e.key === 'f' && e.metaKey && !e.shiftKey && !e.ctrlKey) {
      shouldForward = true;
    }
    // Note: Cmd+W and Cmd+Shift+W are now handled by the application menu
    // and should NOT be forwarded from the webview to avoid double-firing
    // Escape/Enter - for dialogs (but don't prevent default so they still work in websites)
    if (e.key === 'Escape' || e.key === 'Enter') {
      if (typeof window.__electrobunSendToHost === 'function') {
        window.__electrobunSendToHost({
          type: 'bunny:keydown',
          key: e.key,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey
        });
      }
    }

    if (shouldForward) {
      e.preventDefault();
      if (typeof window.__electrobunSendToHost === 'function') {
        window.__electrobunSendToHost({
          type: 'bunny:keydown',
          key: e.key,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey
        });
      }
    }
  });
})();
`;

// Cache plugin preloads at module level (shared across all WebSlate instances)
let cachedPluginPreloads: string | null = null;
let pluginPreloadsPromise: Promise<string> | null = null;

async function getPluginPreloads(): Promise<string> {
	if (cachedPluginPreloads !== null) {
		return cachedPluginPreloads;
	}
	if (pluginPreloadsPromise) {
		return pluginPreloadsPromise;
	}
	pluginPreloadsPromise = (async () => {
		try {
			const { electrobun } = await import("../init");
			const scripts = await electrobun.rpc?.request.pluginGetPreloadScripts();
			cachedPluginPreloads = scripts || "";
			return cachedPluginPreloads;
		} catch (err) {
			console.warn("Failed to load plugin preload scripts:", err);
			cachedPluginPreloads = "";
			return "";
		}
	})();
	return pluginPreloadsPromise;
}

// WebSlates typically have a 'home' path, saved to the node's web slate
// and a 'current url' saved to the tab's url. This lets you open multiple tabs to
// say google or webflow, and have each one navigate around independently and remember
// their current url
// In the web build, esbuild defines __BUNNY_WEB_MODE__ as true.
// In the carrot build it's undefined, so we default to false.
declare const __BUNNY_WEB_MODE__: boolean | undefined;
const isWebMode = typeof __BUNNY_WEB_MODE__ !== "undefined" && __BUNNY_WEB_MODE__ === true;

export const WebSlate = ({
	node,
	tabId,
}: {
	node?: CachedFileType;
	tabId: string;
}) => {
	console.log("WebSlate component created:", { tabId, nodePath: node?.path });
	if (!node) {
		console.error("WebSlate: No node provided for tabId:", tabId);
		return null;
	}

	// In web mode, the electrobun-webview element doesn't exist.
	// Show a simple fallback with a button to open the URL in a new browser tab.
	if (isWebMode) {
		const getUrl = () => {
			const slate = getSlateForNode(node);
			if (slate?.type === "web" && slate.url) return slate.url;
			const currentTab = getWindow()?.tabs[tabId];
			if (currentTab?.type === "web" && currentTab.url) return currentTab.url;
			return "";
		};

		return (
			<div style={{
				width: "100%",
				height: "100%",
				display: "flex",
				"flex-direction": "column",
				"align-items": "center",
				"justify-content": "center",
				background: "#1e1e1e",
				color: "#ccc",
				gap: "16px",
			}}>
				<div style={{ "font-size": "14px", color: "#888" }}>
					Web views are not available in the browser.
				</div>
				<Show when={getUrl()}>
					<div style={{
						"max-width": "500px",
						"text-align": "center",
						"word-break": "break-all",
						"font-size": "12px",
						color: "#999",
						padding: "8px 16px",
						background: "#2a2a2a",
						"border-radius": "6px",
						"margin-bottom": "4px",
					}}>
						{getUrl()}
					</div>
					<a
						href={getUrl()}
						target="_blank"
						rel="noopener noreferrer"
						style={{
							background: "#f59e0b",
							color: "#1e1e1e",
							border: "none",
							"border-radius": "6px",
							padding: "8px 20px",
							"font-size": "13px",
							"font-weight": "600",
							cursor: "pointer",
							"text-decoration": "none",
							display: "inline-block",
						}}
					>
						Open in New Tab
					</a>
				</Show>
			</div>
		);
	}

	const getNodeUrl = () => {
		const slate = getSlateForNode(node);
		// Ensure we return a valid URL or undefined (not an empty string or invalid value)
		return slate?.type === "web" ? slate.url : undefined;
	};
	const tab = () => getWindow()?.tabs[tabId];

	const tabUrl = () => {
		const currentTab = tab();
		return currentTab?.type === "web" && currentTab.url
			? currentTab.url
			: undefined;
	};

	// Get the renderer setting from the slate config
	const renderer = () => {
		const slate = getSlateForNode(node);
		if (slate?.type === "web" && slate.config && "renderer" in slate.config) {
			return slate.config.renderer || "system";
		}
		// Default to WebKit (system) for new browser profiles
		return "system";
	};

	// Helper to detect corrupted or invalid titles
	const isCorruptedTitle = (title: string): boolean => {
		if (!title || typeof title !== "string") {
			return true;
		}

		// Check for replacement character (�) which indicates UTF-8 decoding errors
		if (title.includes("\uFFFD")) {
			return true;
		}

		// Ignore DevTools title changes (this happens when inspecting elements)
		if (title.toLowerCase() === "devtools") {
			return true;
		}

		// Check for other common corrupted patterns
		// (null bytes, control characters except newline/tab)
		if (/[\x00-\x08\x0B-\x0C\x0E-\x1F]/.test(title)) {
			return true;
		}

		return false;
	};

	// just get this once, so we have unidirectinoal flow on navigate -> update store
	// Note: initialUrl must be a valid url, otherwise webview will not initialize properly
	// and will throw. eg: when editing the url in the url bar there won't be a webcontents initialized
	const initialUrl = tabUrl() || getNodeUrl() || "https://www.google.com";

	console.log("WebSlate init:", {
		tabId,
		nodePath: node?.path,
		tabUrl: tabUrl(),
		nodeUrl: getNodeUrl(),
		initialUrl,
		renderer: renderer(),
	});

	// use a different partition for each workspace and renderer type
	// CEF and WebKit need separate partitions to avoid conflicts
	// todo (yoav): make this a util
	const partition = `persist:sites:${state.workspace.id}:${renderer()}`;
	// YYY - any was Electron.WebviewTag
	let webviewRef: any | undefined;
	let findInputRef: HTMLInputElement | undefined;
	const [isWebviewReady, setIsWebviewReady] = createSignal(false);
	// Delay revealing webview after each tab activation (covers both initial
	// creation and subsequent tab switches). Reset on every activation.
	const [revealReady, setRevealReady] = createSignal(false);
	let revealTimer: ReturnType<typeof setTimeout> | null = null;
	let hasBeenRevealedOnce = false;
	const [showFindBar, setShowFindBar] = createSignal(false);
	const [findQuery, setFindQuery] = createSignal("");

	// Keep webview off-screen briefly so the native OOPIF doesn't flash
	const onClickBack = () => {
		webviewRef?.goBack();
	};

	const onClickForward = () => {
		webviewRef?.goForward();
	};

	const onClickReload = () => {
		webviewRef?.reload();
	};

	const onClickHome = () => {
		webviewRef.src = initialUrl;
	};

	const toggleFindBar = () => {
		if (showFindBar()) {
			closeFindBar();
		} else {
			setShowFindBar(true);
			webviewRef?.addMaskSelector(".webslate-find-bar");
			requestAnimationFrame(() => {
				webviewRef?.syncDimensions(true);
				// todo: focusing the input doesn't work when the OOPIF has native focus.
				// Needs a native focusHost/blur API on BrowserView to transfer focus back.
				findInputRef?.focus();
				findInputRef?.select();
			});
		}
	};

	const closeFindBar = () => {
		setShowFindBar(false);
		setFindQuery("");
		webviewRef?.stopFindInPage();
		webviewRef?.removeMaskSelector(".webslate-find-bar");
		requestAnimationFrame(() => {
			webviewRef?.syncDimensions(true);
		});
	};

	const handleFindInput = (query: string) => {
		setFindQuery(query);
		if (query) {
			webviewRef?.findInPage(query, { forward: true });
		} else {
			webviewRef?.stopFindInPage();
		}
	};

	const findNext = () => {
		const q = findQuery();
		if (q) webviewRef?.findInPage(q, { forward: true });
	};

	const findPrev = () => {
		const q = findQuery();
		if (q) webviewRef?.findInPage(q, { forward: false });
	};

	const handleFindKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Enter" || (e.key === "g" && e.metaKey)) {
			e.preventDefault();
			if (e.shiftKey) {
				findPrev();
			} else {
				findNext();
			}
		}
		if (e.key === "Escape") {
			e.preventDefault();
			closeFindBar();
		}
	};

	const onCreatePreloadScript = async () => {
		// This button is only shown for real nodes (browser profiles saved to disk)
		if (!isRealNode() || !node) {
			webviewRef?.openDevTools();
			return;
		}

		const folderPath = node.path;
		const fileName = ".preload.js";
		const defaultContent = `// Preload script for this web browser profile
// This script runs before the page loads and can modify the page behavior

// Example: Hide all ads
// document.addEventListener('DOMContentLoaded', () => {
//   const ads = document.querySelectorAll('[class*="ad"], [id*="ad"]');
//   ads.forEach(ad => ad.style.display = 'none');
// });

// Example: Auto-fill a form
// document.addEventListener('DOMContentLoaded', () => {
//   const usernameField = document.querySelector('input[name="username"]');
//   if (usernameField) {
//     usernameField.value = 'your-username';
//   }
// });

console.log('Preload script loaded for:', window.location.href);
`;

		const filePath = join(folderPath, fileName);

		try {
			// Check if file already exists
			const exists = await electrobun.rpc?.request.exists({ path: filePath });

			let wasCreated = false;
			if (!exists) {
				// Create the file if it doesn't exist
				await electrobun.rpc?.request.touchFile({
					path: filePath,
					contents: defaultContent,
				});
				wasCreated = true;
			}

			if (wasCreated) {
				// Wait a bit for the file system events to be processed and the file to be detected
				setTimeout(() => {
					// Expand the folder
					setNodeExpanded(folderPath!, true);
				}, 500);
			} else {
				// File already exists, expand immediately
				setNodeExpanded(folderPath, true);
			}

			// Open the file in the current pane for editing
			openNewTabForNode(filePath, false, { focusNewTab: true });
		} catch (error) {
			console.error(`Error creating ${fileName}:`, error);
			alert(`Failed to create ${fileName}. Please try again.`);
		}
	};

	const onUrlInputKeyDown = (
		e: DomEventWithTarget<KeyboardEvent, HTMLInputElement>,
	) => {
		if (e.key === "Enter") {
			let newUrl = e.currentTarget.value;
			// Add https:// if no protocol is present
			const hasProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(newUrl);
			if (!hasProtocol) {
				newUrl = `https://${newUrl}`;
			}
			webviewRef.src = newUrl;

			// Start load timeout for the new URL
			startLoadTimeout(newUrl);

			// Update the URL and title in the tab immediately
			setState(
				produce((_state: AppState) => {
					const _tab = getWindow(_state)?.tabs[tabId] as WebTabType;
					_tab.url = newUrl;
					// Extract hostname as initial title
					try {
						const url = new URL(newUrl);
						_tab.title = url.hostname;
					} catch (err) {
						_tab.title = newUrl;
					}
				}),
			);
			updateSyncedState();
		}
	};

	const [isReady, setIsReady] = createSignal(false);
	const [webviewUrl, setWebviewUrl] = createSignal(tabUrl());

	const [isBackDisabled, setIsBackDisabled] = createSignal(true);
	const [isForwardDisabled, setIsForwardDisabled] = createSignal(true);

	// Track load errors to show error page
	// Note: Electrobun doesn't expose did-fail-load events, so we use a timeout approach
	const [loadError, setLoadError] = createSignal<{
		errorDescription: string;
		validatedURL: string;
	} | null>(null);

	// Track loading state for timeout-based error detection
	const [isLoading, setIsLoading] = createSignal(true);
	let loadTimeoutId: ReturnType<typeof setTimeout> | null = null;
	const LOAD_TIMEOUT_MS = 7000; // 7 seconds timeout

	const startLoadTimeout = (_url: string) => {
		// Disabled: timeout-based error detection is unreliable
		// TODO: Add proper error handling in Electrobun via did-fail-load events
		setIsLoading(true);
		setLoadError(null);
	};

	const clearLoadTimeout = () => {
		console.log("[WebSlate] Clearing load timeout");
		if (loadTimeoutId) {
			clearTimeout(loadTimeoutId);
			loadTimeoutId = null;
		}
		setIsLoading(false);
	};

	createEffect(async () => {
		// Note: wait for it to be ready, and wire reactivity to tabUrl
		// which is updated on did-navigate
		const currentTabUrl = tabUrl();
		console.log("WebSlate effect:", {
			tabId,
			isReady: isReady(),
			currentTabUrl,
		});

		if (isReady() && currentTabUrl) {
			// give it a second for cross language rpc to resolve before checking

			// Note: currently in-page-navigations don't trigger canGoBack/Forward
			// TODO: electrobun should likely account for this
			setIsBackDisabled(!(await webviewRef?.canGoBack()));
			setIsForwardDisabled(!(await webviewRef?.canGoForward()));
			setWebviewUrl(currentTabUrl);
			console.log("Set webviewUrl to:", currentTabUrl);
		} else {
			setIsBackDisabled(false);
			setIsForwardDisabled(false);
		}
	});

	// Manage per-activation reveal delay (resets on every tab switch)
	createEffect(() => {
		const active = isTabActive();
		const ready = isWebviewReady();

		if (revealTimer) {
			clearTimeout(revealTimer);
			revealTimer = null;
		}

		if (active && ready) {
			const delay = hasBeenRevealedOnce ? 50 : 400;
			revealTimer = setTimeout(() => {
				hasBeenRevealedOnce = true;
				setRevealReady(true);
			}, delay);
		} else {
			setRevealReady(false);
		}
	});

	createEffect(() => {
		if (!isWebviewReady()) return;

		if (isTabActive()) {
			if (!windowStartupSettled() || !revealReady()) return;
			// Tabs are always slotted now (display:none hides inactive tabs),
			// syncDimensions runs after the tab becomes visible so dimensions are correct.
			webviewRef?.syncDimensions(true);
			webviewRef?.toggleTransparent(false);
			webviewRef?.togglePassthrough(false);
		} else {
			webviewRef?.toggleTransparent(true);
			webviewRef?.togglePassthrough(true);
		}
	});

	const isTabActive = () => {
		const _tab = tab();
		if (!_tab) {
			return false;
		}

		const paneForTab = getPaneWithId(state, _tab?.paneId);
		if (!paneForTab) {
			return false;
		}

		if (paneForTab.type !== "pane" || paneForTab?.currentTabId !== _tab.id) {
			return false;
		}

		return true;
	};

	createEffect(() => {
		if (!isTabActive()) {
			return;
		}

		// Create a single boolean for toggling the menu
		state.ui.showWorkspaceMenu || state.ui.showAppMenu;

		// Perform the syncDimensions call once
		webviewRef?.syncDimensions(true);
	});

	createEffect(() => {
		if (!isTabActive()) {
			return;
		}

		if (state.dragState?.targetPaneId === tab()?.paneId) {
			if (!webviewRef?.transparent) {
				webviewRef?.toggleTransparent(true);
				// webviewRef?.syncScreenshot();
				webviewRef?.syncDimensions(true);
			}
		} else if (revealReady()) {
			requestAnimationFrame(() => {
				if (webviewRef?.transparent) {
					webviewRef?.toggleTransparent(false);
					// webviewRef?.clearScreenImage();
					webviewRef?.syncDimensions(true);
				}
			});
		}
	});

	createEffect(() => {
		if (!isTabActive()) {
			return;
		}

		// Create a single boolean for toggling the menu
		if (state.isResizingPane) {
			// Perform the syncDimensions call and force it to trigger the
			// accelerated syncDimensions loop so dragging is immediately responsive
			// when the mouse starts moving
			webviewRef?.syncDimensions(true);
		}
	});

	const onClickAddBrowserProfile = async () => {
		// This button is only shown for real nodes (browser profiles saved to disk)
		if (!isRealNode() || !node) {
			console.log("Cannot create browser profile: no valid parent folder");
			return;
		}

		const parentFolderPath = node.path;
		const currentUrl = tabUrl();
		if (!currentUrl) {
			return;
		}

		// Get title from tab state
		const _tab = tab();
		const pageTitle = _tab?.type === "web" ? _tab.title : null;

		// Get the current renderer type to preserve it in the new profile
		const currentRenderer = renderer();

		try {
			// Use the shared utility to create a proper browser profile folder name
			const nodeName = await createBrowserProfileFolderName(
				pageTitle,
				currentUrl,
				parentFolderPath,
				electrobun.rpc!.request.makeFileNameSafe,
				electrobun.rpc!.request.getUniqueNewName,
			);
			const browserProfilePath = join(parentFolderPath, nodeName);

			// Create the browser profile directory
			const mkdirResult = await electrobun.rpc?.request.mkdir({
				path: browserProfilePath,
			});
			if (!mkdirResult?.success) {
				console.error(
					"Failed to create browser profile directory:",
					mkdirResult?.error,
				);
				alert("Failed to create browser profile folder. Please try again.");
				return;
			}

			// Write the .bunny.json slate config file
			// Preserve the renderer type from the current tab
			const slateConfig = {
				v: 1,
				name: pageTitle || new URL(currentUrl).hostname,
				icon: "views://assets/file-icons/bookmark.svg",
				type: "web",
				url: currentUrl,
				config: {
					renderer: currentRenderer as "system" | "cef",
				},
			};

			const slateConfigPath = join(browserProfilePath, ".bunny.json");
			const writeResult = await electrobun.rpc?.request.writeFile({
				path: slateConfigPath,
				value: JSON.stringify(slateConfig, null, 2),
			});

			if (!writeResult?.success) {
				console.error("Failed to write slate config:", writeResult?.error);
				// Try to clean up the created directory
				await electrobun.rpc?.request.safeDeleteFileOrFolder({
					absolutePath: browserProfilePath,
				});
				alert(
					"Failed to create browser profile configuration. Please try again.",
				);
				return;
			}

			// Expand the parent folder so the new browser profile is visible
			setNodeExpanded(parentFolderPath, true);

			// Open the new browser profile in a new tab
			openNewTabForNode(browserProfilePath, false, {
				url: currentUrl,
				focusNewTab: true,
			});

			// Fetch and update the favicon asynchronously
			electrobun.rpc?.request
				.getFaviconForUrl({ url: currentUrl })
				.then(async (favicon) => {
					if (favicon && favicon !== slateConfig.icon) {
						// Update the slate config with the favicon
						const updatedSlateConfig = { ...slateConfig, icon: favicon };
						await electrobun.rpc?.request.writeFile({
							path: slateConfigPath,
							value: JSON.stringify(updatedSlateConfig, null, 2),
						});
					}
				})
				.catch((error) => {
					console.error("Failed to fetch favicon:", error);
					// Non-critical error, browser profile is already created
				});
		} catch (error) {
			console.error("Error creating browser profile:", error);
			console.error("Debug info:", {
				isRealNode: isRealNode(),
				isQuickBrowser: isQuickBrowser(),
				parentFolderPath,
				currentUrl,
				pageTitle: _tab?.type === "web" ? _tab.title : null,
				tabType: _tab?.type,
			});
			alert("Failed to create browser profile. Please try again.");
		}
	};

	// Save browser profile for quick access tabs - opens folder picker and auto-adds project if needed
	const onClickSaveBrowserProfile = async () => {
		const currentUrl = tabUrl();
		if (!currentUrl) {
			return;
		}

		// Get title from tab state
		const _tab = tab();
		const pageTitle = _tab?.type === "web" ? _tab.title : null;

		// Get the current renderer type to preserve it in the new profile
		const currentRenderer = renderer();

		try {
			// Open folder picker
			const result = await electrobun.rpc?.request.openFileDialog({
				startingFolder: state.paths?.BUNNY_HOME_FOLDER || "",
				allowedFileTypes: "",
				canChooseFiles: false,
				canChooseDirectory: true,
				allowsMultipleSelection: false,
			});

			if (!result || result.length === 0) {
				// User cancelled
				return;
			}

			const selectedPath = result[0];

			// Check if this path is inside an existing project
			const existingProject = getProjectForNodePath(selectedPath);

			if (!existingProject) {
				// Add the selected folder as a new project
				const projectName = selectedPath.split("/").pop() || "Browser Profiles";
				await electrobun.rpc?.request.addProject({
					projectName,
					path: selectedPath,
				});

				// Wait a bit for the project to be created and file watcher to pick it up
				await new Promise((resolve) => setTimeout(resolve, 500));
			}

			// Now create the browser profile in the selected folder
			const nodeName = await createBrowserProfileFolderName(
				pageTitle,
				currentUrl,
				selectedPath,
				electrobun.rpc!.request.makeFileNameSafe,
				electrobun.rpc!.request.getUniqueNewName,
			);
			const browserProfilePath = join(selectedPath, nodeName);

			// Create the browser profile directory
			const mkdirResult = await electrobun.rpc?.request.mkdir({
				path: browserProfilePath,
			});
			if (!mkdirResult?.success) {
				console.error(
					"Failed to create browser profile directory:",
					mkdirResult?.error,
				);
				alert("Failed to create browser profile folder. Please try again.");
				return;
			}

			// Write the .bunny.json slate config file
			const slateConfig = {
				v: 1,
				name: pageTitle || new URL(currentUrl).hostname,
				icon: "views://assets/file-icons/bookmark.svg",
				type: "web",
				url: currentUrl,
				config: {
					renderer: currentRenderer as "system" | "cef",
				},
			};

			const slateConfigPath = join(browserProfilePath, ".bunny.json");
			const writeResult = await electrobun.rpc?.request.writeFile({
				path: slateConfigPath,
				value: JSON.stringify(slateConfig, null, 2),
			});

			if (!writeResult?.success) {
				console.error("Failed to write slate config:", writeResult?.error);
				// Try to clean up the created directory
				await electrobun.rpc?.request.safeDeleteFileOrFolder({
					absolutePath: browserProfilePath,
				});
				alert(
					"Failed to create browser profile configuration. Please try again.",
				);
				return;
			}

			// Expand the folder so the new browser profile is visible
			setNodeExpanded(selectedPath, true);

			// Open the new browser profile in a new tab
			openNewTabForNode(browserProfilePath, false, {
				url: currentUrl,
				focusNewTab: true,
			});

			// Fetch and update the favicon asynchronously
			electrobun.rpc?.request
				.getFaviconForUrl({ url: currentUrl })
				.then(async (favicon) => {
					if (favicon && favicon !== slateConfig.icon) {
						const updatedSlateConfig = { ...slateConfig, icon: favicon };
						await electrobun.rpc?.request.writeFile({
							path: slateConfigPath,
							value: JSON.stringify(updatedSlateConfig, null, 2),
						});
					}
				})
				.catch((error) => {
					console.error("Failed to fetch favicon:", error);
				});
		} catch (error) {
			console.error("Error saving browser profile:", error);
			alert("Failed to save browser profile. Please try again.");
		}
	};

	// todo (yoav): https://www.electronjs.org/docs/latest/api/webview-tag
	// reload
	// reloadIgnoringCache
	// open devtools
	// context menues
	// capturePage
	// showDefinitionForSelection

	const isRealNode = createMemo(
		() =>
			node &&
			!node.path.startsWith("__BUNNY_INTERNAL__") &&
			!node.path.startsWith("__BUNNY_TEMPLATE__"),
	);

	// Check if this is a quick browser tab (opened from quick access)
	const isQuickBrowser = createMemo(() =>
		node?.path.startsWith("__BUNNY_TEMPLATE__/browser-"),
	);

	// For real nodes, get the preload script path from the node's folder
	// Quick browser tabs don't have preload scripts (they're ephemeral)
	const preloadFilePath = createMemo(() => {
		return isRealNode() && node ? join(node.path, ".preload.js") : "";
	});

	const [preloadContent, setPreloadContent] = createSignal("");
	const [preloadLoaded, setPreloadLoaded] = createSignal(false);
	const [pluginPreloads, setPluginPreloads] = createSignal(
		cachedPluginPreloads || "",
	);

	// Load preload content - runs whenever preloadFilePath changes or file cache updates
	createEffect(() => {
		setPreloadLoaded(false); // Start loading

		const loadAllPreloads = async () => {
			// Load plugin preloads (cached at module level)
			const plugins = await getPluginPreloads();
			setPluginPreloads(plugins);

			// Load node-specific preload if applicable
			if (!preloadFilePath()) {
				setPreloadContent("");
				setPreloadLoaded(true);
				return;
			}

			// Always try to read the file directly first - this ensures we get the latest content
			try {
				const { textContent } =
					(await electrobun.rpc?.request.readFile({
						path: preloadFilePath(),
					})) || {};

				if (textContent) {
					setPreloadContent(textContent);
					setPreloadLoaded(true);
					return;
				}
			} catch (err) {
				// File doesn't exist or can't be read, ignore error
			}

			// Fallback: check if we have cached content
			const cachedNode = getNode(preloadFilePath());

			if (
				cachedNode &&
				cachedNode.type === "file" &&
				cachedNode.persistedContent
			) {
				setPreloadContent(cachedNode.persistedContent);
			} else {
				setPreloadContent("");
			}

			setPreloadLoaded(true);
		};

		loadAllPreloads();
	});

	// Also watch for changes in the file cache for this specific preload file
	createEffect(() => {
		if (!preloadFilePath()) return;

		const cachedNode = getNode(preloadFilePath());

		if (
			cachedNode &&
			cachedNode.type === "file" &&
			cachedNode.persistedContent
		) {
			setPreloadContent(cachedNode.persistedContent);
		}
	});

	const preloadScript = () => {
		const parts = [bunnyPreloadScript];

		// Add plugin preloads
		const pluginScripts = pluginPreloads();
		if (pluginScripts) {
			parts.push(pluginScripts);
		}

		// Add node-specific preload
		const nodePreload = preloadContent();
		if (nodePreload) {
			parts.push(nodePreload);
		}

		return parts.join(";\n");
	};

	return (
		<div
			style="display: flex; flex-direction: column; height: 100%; position: relative;"
			onKeyDown={(e) => {
				if (e.key === "f" && e.metaKey && !e.shiftKey && !e.ctrlKey) {
					e.preventDefault();
					toggleFindBar();
				}
				if (e.key === "Escape" && showFindBar()) {
					e.preventDefault();
					closeFindBar();
				}
			}}
		>
			<div style="display: flex; box-sizing: border-box; gap: 5px; padding: 10px; min-height: 40px;height: 40px; width: 100%;overflow-x:hidden;">
				<button
					class="browser-btn"
					disabled={isBackDisabled()}
					type="button"
					onClick={onClickBack}
				>
					<img
						width="16"
						height="16"
						src={`views://assets/file-icons/browser-back.svg`}
					/>
				</button>
				<button
					disabled={isForwardDisabled()}
					type="button"
					onClick={onClickForward}
					class="browser-btn"
				>
					<img
						width="16"
						height="16"
						src={`views://assets/file-icons/browser-forward.svg`}
					/>
				</button>
				<button class="browser-btn" type="button" onClick={onClickReload}>
					<img
						width="12"
						height="12"
						src={`views://assets/file-icons/browser-reload.svg`}
					/>
				</button>

				<button class="browser-btn" type="button" onClick={onClickHome}>
					<img
						width="12"
						height="12"
						src={`views://assets/file-icons/browser-home.svg`}
					/>
				</button>

				<input
					style="flex-grow: 1;
        background: #444;
        border: inset 1px #555;
        color: #ddd;
        font-size: 13px;
        font-weight: bold;
        padding: 5px;
        outline: none;"
					type="text"
					value={webviewUrl()}
					onKeyDown={onUrlInputKeyDown}
				/>
				{/* Download indicator - shows when there's an active/completed download */}
				<Show when={state.downloadNotification}>
					{(() => {
						const [showIcon, setShowIcon] = createSignal(false);

						// When download completes, show checkmark briefly then switch to icon
						createEffect(() => {
							if (state.downloadNotification?.status === "completed") {
								setTimeout(() => setShowIcon(true), 1000);
							} else {
								setShowIcon(false);
							}
						});

						return (
							<button
								class="browser-btn"
								type="button"
								onClick={async () => {
									const notification = state.downloadNotification;
									if (
										notification?.status === "completed" &&
										notification.path
									) {
										await electrobunImport.rpc?.request.showInFinder({
											path: notification.path,
										});
										setState("downloadNotification", null);
									} else if (notification?.status === "failed") {
										setState("downloadNotification", null);
									}
								}}
								title={
									state.downloadNotification?.status === "downloading"
										? `Downloading: ${state.downloadNotification?.filename} (${state.downloadNotification?.progress || 0}%)`
										: state.downloadNotification?.status === "completed"
											? `Show ${state.downloadNotification?.filename} in Finder`
											: `Download failed: ${state.downloadNotification?.filename}`
								}
							>
								<Show
									when={state.downloadNotification?.status === "downloading"}
								>
									{/* Circular progress indicator */}
									<svg
										width="16"
										height="16"
										viewBox="0 0 18 18"
										style={{ transform: "rotate(-90deg)" }}
									>
										{/* Background circle */}
										<circle
											cx="9"
											cy="9"
											r="7"
											fill="none"
											stroke="#555"
											stroke-width="2"
										/>
										{/* Progress circle */}
										<circle
											cx="9"
											cy="9"
											r="7"
											fill="none"
											stroke="#4ade80"
											stroke-width="2"
											stroke-dasharray={`${(state.downloadNotification?.progress || 0) * 0.44} 44`}
											stroke-linecap="round"
										/>
									</svg>
								</Show>
								<Show when={state.downloadNotification?.status === "completed"}>
									<Show
										when={!showIcon()}
										fallback={
											/* Download folder icon - arrow into tray */
											<svg
												width="12"
												height="12"
												viewBox="0 0 16 16"
												fill="none"
											>
												{/* Down arrow */}
												<path
													d="M8 2v7M5 6l3 3 3-3"
													stroke="#aaa"
													stroke-width="1.5"
													stroke-linecap="round"
													stroke-linejoin="round"
												/>
												{/* Tray/folder bottom */}
												<path
													d="M3 10v3h10v-3"
													stroke="#aaa"
													stroke-width="1.5"
													stroke-linecap="round"
													stroke-linejoin="round"
												/>
											</svg>
										}
									>
										<svg width="12" height="12" viewBox="0 0 12 12">
											<path
												d="M2 6l3 3 5-6"
												fill="none"
												stroke="#4ade80"
												stroke-width="2"
												stroke-linecap="round"
												stroke-linejoin="round"
											/>
										</svg>
									</Show>
								</Show>
								<Show when={state.downloadNotification?.status === "failed"}>
									<svg width="12" height="12" viewBox="0 0 12 12">
										<path
											d="M2 2l8 8M10 2l-8 8"
											fill="none"
											stroke="#f87171"
											stroke-width="2"
											stroke-linecap="round"
										/>
									</svg>
								</Show>
							</button>
						);
					})()}
				</Show>
				{/* For quick access browser tabs, show "Save Browser Profile" button */}
				<Show when={isQuickBrowser()}>
					<button
						class="browser-btn"
						type="button"
						onClick={onClickSaveBrowserProfile}
						title="Save as Browser Profile"
					>
						<img
							width="12"
							height="12"
							src={`views://assets/file-icons/browser-add-bookmark.svg`}
						/>
					</button>
				</Show>
				{/* For real browser profile nodes, show add nested profile and preload script buttons */}
				<Show when={isRealNode()}>
					<button
						class="browser-btn"
						type="button"
						onClick={onClickAddBrowserProfile}
						title="Save Nested Browser Profile"
					>
						<img
							width="12"
							height="12"
							src={`views://assets/file-icons/browser-add-bookmark.svg`}
						/>
					</button>
					<button
						class="browser-btn"
						type="button"
						onClick={onCreatePreloadScript}
						title="Edit Preload Script"
					>
						<img
							width="12"
							height="12"
							src={`views://assets/file-icons/browser-script.svg`}
						/>
					</button>
				</Show>
			</div>

			{/* Find in page bar - floats over top-right of webview, masked out of OOPIF */}
			<Show when={showFindBar()}>
				<div
					class="webslate-find-bar"
					style={{
						position: "absolute",
						top: "44px",
						right: "8px",
						"z-index": "100",
						display: "flex",
						gap: "4px",
						"align-items": "center",
						padding: "6px 10px",
						background: "#2d2d2d",
						"border-radius": "6px",
						border: "1px solid #444",
						"box-shadow": "0 2px 8px rgba(0,0,0,0.4)",
					}}
				>
					<input
						ref={findInputRef}
						type="text"
						placeholder="Find in page..."
						value={findQuery()}
						onInput={(e) => handleFindInput(e.currentTarget.value)}
						onKeyDown={handleFindKeyDown}
						style={{
							padding: "4px 8px",
							"border-radius": "4px",
							border: "1px solid #555",
							"background-color": "#1e1e1e",
							color: "#ddd",
							"font-size": "13px",
							width: "200px",
							outline: "none",
						}}
					/>
					<button
						onClick={findPrev}
						type="button"
						title="Previous match (Shift+Enter)"
						style={{
							background: "#3a3a3a",
							border: "1px solid #555",
							"border-radius": "4px",
							cursor: "pointer",
							padding: "4px 6px",
							display: "flex",
							"align-items": "center",
							"justify-content": "center",
						}}
					>
						<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
							<path
								d="M6 9.5V2.5M6 2.5L2.5 6M6 2.5L9.5 6"
								stroke="#ccc"
								stroke-width="1.5"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
					</button>
					<button
						onClick={findNext}
						type="button"
						title="Next match (Enter)"
						style={{
							background: "#3a3a3a",
							border: "1px solid #555",
							"border-radius": "4px",
							cursor: "pointer",
							padding: "4px 6px",
							display: "flex",
							"align-items": "center",
							"justify-content": "center",
						}}
					>
						<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
							<path
								d="M6 2.5V9.5M6 9.5L2.5 6M6 9.5L9.5 6"
								stroke="#ccc"
								stroke-width="1.5"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
					</button>
					<button
						onClick={closeFindBar}
						type="button"
						title="Close (Escape)"
						style={{
							background: "#3a3a3a",
							border: "1px solid #555",
							"border-radius": "4px",
							cursor: "pointer",
							padding: "4px 6px",
							display: "flex",
							"align-items": "center",
							"justify-content": "center",
						}}
					>
						<svg width="10" height="10" viewBox="0 0 10 10" fill="none">
							<path
								d="M1.5 1.5L8.5 8.5M8.5 1.5L1.5 8.5"
								stroke="#999"
								stroke-width="1.5"
								stroke-linecap="round"
							/>
						</svg>
					</button>
				</div>
			</Show>

			{/* Error overlay - shown when page fails to load */}
			<Show when={loadError()}>
				<div
					class="webview-overlay"
					style={{
						position: "absolute",
						top: "40px",
						left: "0",
						right: "0",
						bottom: "0",
						background: "#1e1e1e",
						display: "flex",
						"flex-direction": "column",
						"align-items": "center",
						"justify-content": "center",
						"z-index": "10",
						padding: "40px",
						"text-align": "center",
					}}
				>
					<div
						style={{
							"max-width": "400px",
							display: "flex",
							"flex-direction": "column",
							"align-items": "center",
							gap: "16px",
						}}
					>
						{/* Error icon */}
						<div
							style={{
								width: "64px",
								height: "64px",
								"border-radius": "50%",
								background: "#333",
								display: "flex",
								"align-items": "center",
								"justify-content": "center",
								"font-size": "32px",
								color: "#888",
							}}
						>
							⚠
						</div>

						{/* Error title */}
						<h2
							style={{
								margin: "0",
								color: "#ddd",
								"font-size": "18px",
								"font-weight": "600",
							}}
						>
							{loadError()?.errorDescription === "TIMEOUT"
								? "Page Took Too Long to Load"
								: "Can't Connect to Server"}
						</h2>

						{/* Error description */}
						<p
							style={{
								margin: "0",
								color: "#888",
								"font-size": "14px",
								"line-height": "1.5",
							}}
						>
							{loadError()?.errorDescription === "TIMEOUT"
								? "The page didn't respond in time. The server may be slow, unreachable, or the URL may be incorrect."
								: "Could not connect to the server. Check that the URL is correct and that you have an internet connection."}
						</p>

						{/* URL that failed */}
						<p
							style={{
								margin: "0",
								color: "#666",
								"font-size": "12px",
								"word-break": "break-all",
								"max-width": "100%",
							}}
						>
							{loadError()?.validatedURL}
						</p>

						{/* Try Again button */}
						<button
							type="button"
							onClick={() => {
								const url = loadError()?.validatedURL || tabUrl() || initialUrl;
								setLoadError(null);
								startLoadTimeout(url);
								webviewRef?.reload();
							}}
							style={{
								"margin-top": "8px",
								padding: "8px 24px",
								background: "#3b82f6",
								color: "#fff",
								border: "none",
								"border-radius": "6px",
								"font-size": "14px",
								"font-weight": "500",
								cursor: "pointer",
							}}
						>
							Try Again
						</button>
					</div>
				</div>
			</Show>

			<Show
				when={preloadLoaded()}
				fallback={
					<div
						style={{
							width: "calc(100% - 4px)",
							height: "calc(100% - 4px)",
							background: "#1e1e1e",
							display: "flex",
							"align-items": "center",
							"justify-content": "center",
							color: "#888",
						}}
					>
						Loading...
					</div>
				}
			>
				{/* @ts-ignore */}
				<electrobun-webview
					data-type="webslate"
					masks=".webview-overlay"
					renderer={renderer()}
					transparent
					passthrough
					style={{
						width: `calc(100% - 4px)`,
						height: "calc(100% - 4px)",
						background: "#1e1e1e",
						"min-height": "0px",
						"background-size": "fit",
					}}
					partition={partition}
					src={initialUrl}
					preload={preloadScript()}
					ref={(el: any) => {
						webviewRef = el;

						if (!webviewRef) {
							return;
						}

						// Watch for webviewId to be assigned (initWebview sets the id attribute).
						// The webview starts transparent+passthrough via HTML attributes, so no
						// RPC race — the active/inactive effect reveals it when ready.
						const observer = new MutationObserver(() => {
							if (el.webviewId != null) {
								observer.disconnect();
								requestAnimationFrame(() => {
									el.syncDimensions(true);
								});
								setIsWebviewReady(true);
							}
						});
						observer.observe(el, { attributes: true, attributeFilter: ["id"] });

						webviewRef.on("dom-ready", () => {
							console.log(
								"dom-ready event fired for webview:",
								webviewRef.webviewId,
							);
							setIsReady(true);
							// Update title when DOM is ready
							const pageTitle = webviewRef?.getTitle?.();
							console.log("getTitle result:", pageTitle);
							if (
								pageTitle &&
								typeof pageTitle === "string" &&
								!isCorruptedTitle(pageTitle)
							) {
								setState(
									produce((_state: AppState) => {
										const _tab = getWindow(_state)?.tabs[tabId] as WebTabType;
										_tab.title = pageTitle;
									}),
								);
							}
						});

						// Listen for page title updates
						webviewRef.on("page-title-updated", (e: any) => {
							console.log("page-title-updated event:", e.detail);
							// Validate title before setting it
							const newTitle = e.detail;
							if (
								typeof newTitle === "string" &&
								newTitle.trim() &&
								!isCorruptedTitle(newTitle)
							) {
								setState(
									produce((_state: AppState) => {
										const _tab = getWindow(_state)?.tabs[tabId] as WebTabType;
										_tab.title = newTitle;
									}),
								);
							}
						});

						// YYYY - DidNavigateEvent
						// @ts-ignore
						webviewRef.on("did-navigate", async (e: DidNavigateEvent) => {
							console.log("did-navigate event:", e.detail);

							// Ignore DevTools and other internal URLs - don't persist these
							const url = e.detail;
							if (
								!url ||
								(!url.startsWith("http://") &&
									!url.startsWith("https://") &&
									!url.startsWith("file://")) ||
								url.toLowerCase().includes("devtools")
							) {
								console.log("Ignoring non-web URL:", url);
								return;
							}

							// Update URL immediately
							setState(
								produce((_state: AppState) => {
									const _tab = getWindow(_state)?.tabs[tabId] as WebTabType;
									_tab.url = url;

									// Only set a temporary hostname-based title if:
									// 1. There's no existing title, OR
									// 2. The existing title is corrupted
									const currentTitle = _tab.title;
									const shouldSetTempTitle =
										!currentTitle || isCorruptedTitle(currentTitle);

									if (shouldSetTempTitle) {
										// Extract hostname as a temporary title until we get the real page title
										try {
											const url = new URL(e.detail);
											_tab.title = url.hostname;
										} catch (err) {
											// Invalid URL, don't set a title - wait for page-title-updated event
											console.warn("Invalid URL in did-navigate:", e.detail);
										}
									}
								}),
							);

							// Fetch favicon for the new URL
							electrobun.rpc?.request
								.getFaviconForUrl({ url: e.detail })
								.then((favicon) => {
									if (favicon) {
										// Update the tab's icon in the slate config if this is a real browser profile node
										if (isRealNode() && node) {
											const slateConfigPath = join(node.path, ".bunny.json");
											electrobun.rpc?.request
												.readFile({ path: slateConfigPath })
												.then((content) => {
													if (content) {
														try {
															const slateConfig = JSON.parse(content);
															slateConfig.icon = favicon;
															electrobun.rpc?.request.writeFile({
																path: slateConfigPath,
																value: JSON.stringify(slateConfig, null, 2),
															});
														} catch (error) {
															console.error(
																"Error updating slate config favicon:",
																error,
															);
														}
													}
												})
												.catch((error) => {
													console.error(
														"Error reading slate config for favicon update:",
														error,
													);
												});
										}
									}
								})
								.catch((error) => {
									console.error("Error fetching favicon on navigation:", error);
								});

							updateSyncedState();
						});
						webviewRef.on(
							"did-navigate-in-page",
							(e: DidNavigateInPageEvent) => {
								if (!e.isMainFrame) {
									return;
								}

								// Ignore DevTools and other internal URLs
								const url = e.detail;
								if (
									!url ||
									(!url.startsWith("http://") &&
										!url.startsWith("https://") &&
										!url.startsWith("file://")) ||
									url.toLowerCase().includes("devtools")
								) {
									return;
								}

								setState(
									produce((_state: AppState) => {
										const _tab = getWindow(_state)?.tabs[tabId] as WebTabType;
										_tab.url = url;
										// Get the title after in-page navigation
										const pageTitle = webviewRef?.getTitle();
										if (
											pageTitle &&
											typeof pageTitle === "string" &&
											!isCorruptedTitle(pageTitle)
										) {
											_tab.title = pageTitle;
										}
									}),
								);

								updateSyncedState();
							},
						);

						webviewRef.on("new-window-open", (e: any) => {
							console.log("----->>> new window open fired in webview");
							try {
								// const data = JSON.parse(e.detail)
								const targetUrl = e.detail.url;
								openNewTabForNode(node.path, false, {
									url: targetUrl,
									focusNewTab: false,
									targetPaneId: tab()?.paneId,
								});
							} catch (e) {
								console.log(e);
							}
						});

						// Listen for messages from webview preload scripts
						webviewRef.on("host-message", (e: any) => {
							const msg = e.detail;

							// Page loaded successfully - preload script executed
							if (msg?.type === "bunny:page-loaded") {
								console.log(
									"[WebSlate] Page loaded message received from preload",
								);
								clearLoadTimeout();
							}

							// Keyboard shortcuts forwarded from webview
							// This allows Ctrl+Tab/Ctrl+Shift+Tab and Cmd+F to work even when the webview OOPIF has focus
							if (msg?.type === "bunny:keydown") {
								// Handle Cmd+F locally for find-in-page
								if (
									msg.key === "f" &&
									msg.metaKey &&
									!msg.shiftKey &&
									!msg.ctrlKey
								) {
									toggleFindBar();
									return;
								}
								// Handle Escape to close find bar
								if (msg.key === "Escape" && showFindBar()) {
									closeFindBar();
									return;
								}
								// Dispatch a synthetic keyboard event to the document so it bubbles up
								// to the global keydown handler in index.tsx
								const syntheticEvent = new KeyboardEvent("keydown", {
									key: msg.key,
									ctrlKey: msg.ctrlKey,
									shiftKey: msg.shiftKey,
									altKey: msg.altKey,
									metaKey: msg.metaKey,
									bubbles: true,
									cancelable: true,
								});
								document.dispatchEvent(syntheticEvent);
							}
						});

						// XXX - webview focus
						// webviewRef.addEventListener("focus", () => {
						//   focusTabWithId(tabId);
						// });
					}}
				></electrobun-webview>
			</Show>
		</div>
	);
};
