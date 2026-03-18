import {
	type Accessor,
	For,
	type JSX,
	Match,
	Show,
	Switch,
	createEffect,
	createMemo,
	createRenderEffect,
	createSignal,
	onCleanup,
	onMount,
} from "solid-js";
import { produce, reconcile, unwrap } from "solid-js/store";
import { render, untrack } from "solid-js/web";
import "./FileWatcher";
// import { Electroview } from "electrobun/view";
// import { type WorkspaceRPC } from "./rpc";
import { electrobun } from "./init";

import {
	//   createDevlinkFiles,
	getProjectForNode,
	getSlateForNode,
	isDescendantPath,
	isProjectRoot,
	getProjectByRootPath,
	writeSlateConfigFile,
	findPluginSlateForFile,
	loadPluginSlates,
	type PluginSlateInfo,
} from "./files";

import { makeFileNameSafe } from "../../shared/utils/files";
import "./index.css";
import {
	type AppState,
	type FileTabType,
	type LayoutContainerType,
	type LayoutPaneType,
	type PaneLayoutType,
	type TabType,
	type TerminalTabType,
	type WebTabType,
	type WindowType,
	addOpenFile,
	closeTab,
	editNodeSettings,
	focusTabWithId,
	getCurrentPane,
	getCurrentTab,
	getPane,
	getPaneWithId,
	getRootPane,
	getUniqueId,
	getWindow,
	openFileAt,
	openNewTab,
	openNewTabForNode,
	removeOpenFile,
	removeProjectFromBunnyDash,
	setNodeExpanded,
	setPreviewNode,
	setPreviewNodeSlateConfig,
	setPreviewNodeSlateIcon,
	setPreviewNodeSlateName,
	setPreviewNodeSlateToken,
	setPreviewNodeSlateUrl,
	setState,
	// fullyDeleteNode,
	splitPane,
	state,
	syncWorkspaceNow,
	updateSyncedAppSettings,
	updateSyncedState,
	walkPanesForId,
} from "./store";


import type {
	CachedFileType,
	DomEventWithTarget,
	FileNodeType,
	PostMessageShowContextMenu,
	PreviewFileTreeType,
	ProjectType,
	SlateType,
} from "../../shared/types/types";

import {
	FindAllResultsTree,
	OpenFilesTree,
	ProjectsTree,
	WorkspaceLensesTree,
	TemplateNodes,
	createContextMenuAction,
	getIconForNode,
} from "./FileTree";
import { getNode } from "./FileWatcher";
import { BlackboardAnimation } from "./components/BlackboardAnimation";
import { GitHubRepoSelector } from "./components/GitHubRepoSelector";
import { StatusBar } from "./components/StatusBar";
import { Dialog } from "./components/Dialog";
import { TopBar } from "./components/TopBar";
import { type GitHubRepository, githubService } from "./services/githubService";
import { BunnyCloudSettings } from "./settings/BunnyCloudSettings";
import { GitHubSettings } from "./settings/GitHubSettings";
import { LlamaSettings } from "./settings/LlamaSettings";
import { PluginMarketplace } from "./settings/PluginMarketplace";
import { PluginSettings } from "./settings/PluginSettings";
import {
	SettingsInputField,
	SettingsPaneField,
	SettingsPaneFormSection,
	SettingsPaneSaveClose,
	SettingsReadonlyField,
} from "./settings/forms";

import { parentNodePath } from "../utils/fileUtils";

import { join } from "../utils/pathUtils";

import { Editor } from "./CodeEditor";
import { AgentSlate } from "./slates/AgentSlate";
import { GitSlate } from "./slates/GitSlate";
import { PluginSlate } from "./slates/PluginSlate";
// XXX - terminal slate
import { TerminalSlate } from "./slates/TerminalSlate";
import { WebSlate } from "./slates/WebSlate";

// todo (yoav): download this somewhere and move them to files.ts or something
const defaultWebFaviconUrl = () => "views://assets/file-icons/bookmark.svg";

// Removed DEFAULT_HOME_URL - no longer needed without new tab button

// Global ref for Find All input (for keyboard shortcut)
let globalFindAllInput: HTMLInputElement | undefined;

// We prevent the browser window's webcontents
// from closing. This prevents cmd+w from shutting it down
// and cmd+r from refreshing it.
// Even though we catch those in mouseDown and preventDefault
// when done inside a nested <webview> they still propagate and affect the window
// Note: this is overridden when we actually do want to
// close the window from main using webContents.on('will-prevent-unload')
window.onbeforeunload = (e) => {
	e.preventDefault();
	return true;
};

window.open = (url, target) => {
	console.log("new window open!");
	// Note: We handle opening new windows from nested webviews
	// in the main process.
	// Here we need to handle new windows opened from the browserWindow
	// itself, ie: clicking on a mdn link in a code editor hover widget
	console.log("opening window!", url, target);
	openNewTabForNode("__BUNNY_INTERNAL__/web", false, {
		url,
		focusNewTab: false,
	});
	return null;
};

// Close window confirmation dialog state
const [closeWindowDialogOpen, setCloseWindowDialogOpen] = createSignal(false);

const confirmCloseWindow = () => {
	setCloseWindowDialogOpen(false);
	electrobun.rpc?.send.closeWindow();
};

// Listen for close window dialog event from init.ts closeCurrentWindow handler
window.addEventListener('showCloseWindowDialog', () => {
	setCloseWindowDialogOpen(true);
});

document.addEventListener(
	"keydown",
	(e) => {
		// console.info(e.key);
		// todo (yoav): come up with pattern of hot keys
		// eg: shift always reverses direction of implied-direction shortcuts
		// for directional shortcuts (like cmd+right) to focus the next pane
		// shift adds an actual change effect to it like (split pane).
		// or maybe ctrl is for tabs and cmd is for windows
		// or cmd +- shift is a modifier for direction
		// and cmd +- ctrl is a modifier for action/modification

		// todo (yoav): normalize the pattern here so each shortcut is its own function
		// that gets registered

		if (e.key === "f" && e.metaKey === true && e.shiftKey === true) {
			// cmd+shift+f - focus Find All input
			e.preventDefault();
			e.stopImmediatePropagation();
			if (globalFindAllInput) {
				// Show sidebar if hidden
				const currentWindow = getWindow();
				if (currentWindow && !currentWindow.ui.showSidebar) {
					setState(
						"workspace",
						"windows",
						(w) => w.id === currentWindow.id,
						"ui",
						"showSidebar",
						true,
					);
					updateSyncedState();
				}
				// Focus the input after a brief delay to ensure sidebar is visible
				setTimeout(() => {
					globalFindAllInput?.focus();
					globalFindAllInput?.select();
				}, 100);
			}
		} else if (e.key === "p" && e.metaKey === true && e.shiftKey === true) {
			// cmd+shift+p - open command palette
			e.preventDefault();
			e.stopImmediatePropagation();
			setState("ui", "showCommandPalette", true);
		// cmd+t handled by application menu via newBrowserTab RPC
		// cmd+w handled by application menu via closeCurrentTab RPC
		// cmd+shift+w handled by application menu via closeCurrentWindow RPC
		} else if (e.key === "r" && e.metaKey === true) {
			// refresh the current tab
			const currentTab = getCurrentTab();
			if (!currentTab) {
				return null;
			}
			// YYY - any was Type Electron.WebviewTag
			const webview: any | null = document.querySelector(
				`[data-tabId="${currentTab.id}"] electrobun-webview`,
			);

			if (!webview) {
				return null;
			}

			if (e.shiftKey === true) {
				// XXX - hard reload for webviewtag
				// webview.reloadIgnoringCache();
			} else {
				webview.reload();
			}

			console.log("refresh current tab");
			// Removed Cmd+T shortcut - no longer creating node-less web tabs
		} else if (e.key === "Tab" && e.ctrlKey === true && e.shiftKey === true) {
			// cycle to previous tab in pane (Ctrl+Shift+Tab)
			e.preventDefault();
			setState(
				produce((_state: AppState) => {
					const win = getWindow(_state);
					if (!win) {
						return;
					}
					const currentPane = getCurrentPane(_state) as LayoutPaneType;
					if (!currentPane || !currentPane.currentTabId) {
						return;
					}

					const currentTabIndex = currentPane.tabIds.indexOf(
						currentPane.currentTabId,
					);
					const nextTabIndex =
						(currentTabIndex - 1 + currentPane.tabIds.length) % currentPane.tabIds.length;
					const nextTabId = currentPane.tabIds[nextTabIndex];
					currentPane.currentTabId = nextTabId;
				}),
			);
		} else if (e.key === "Tab" && e.ctrlKey === true) {
			// cycle to next tab in pane (Ctrl+Tab)
			e.preventDefault();
			setState(
				produce((_state: AppState) => {
					const win = getWindow(_state);
					if (!win) {
						return;
					}
					const currentPane = getCurrentPane(_state) as LayoutPaneType;
					if (!currentPane || !currentPane.currentTabId) {
						return;
					}

					const currentTabIndex = currentPane.tabIds.indexOf(
						currentPane.currentTabId,
					);
					const nextTabIndex =
						(currentTabIndex + 1) % currentPane.tabIds.length;
					const nextTabId = currentPane.tabIds[nextTabIndex];
					currentPane.currentTabId = nextTabId;
				}),
			);
		} else if (e.key === "l" && e.metaKey === true) {
			// split pane to the right
			console.log("focos url bar");
		}

		// Check plugin keybindings (global context)
		checkPluginKeybindings(e, 'global');
	},
	true,
);

// Plugin keybinding cache (refreshed periodically)
let pluginKeybindingsCache: Array<{
	key: string;
	command: string;
	when?: 'editor' | 'terminal' | 'global';
}> = [];
let keybindingsCacheTime = 0;
const KEYBINDINGS_CACHE_TTL = 5000; // 5 seconds

async function refreshPluginKeybindings() {
	try {
		const keybindings = await electrobun.rpc?.request.pluginGetKeybindings();
		if (keybindings) {
			pluginKeybindingsCache = keybindings;
			keybindingsCacheTime = Date.now();
		}
	} catch (err) {
		console.warn('Failed to fetch plugin keybindings:', err);
	}
}

// Helper to parse a key string like "ctrl+shift+m" into modifiers
function parseKeyString(keyStr: string): { key: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean } {
	const parts = keyStr.toLowerCase().split('+');
	const key = parts[parts.length - 1];
	return {
		key,
		ctrl: parts.includes('ctrl'),
		shift: parts.includes('shift'),
		alt: parts.includes('alt'),
		meta: parts.includes('meta') || parts.includes('cmd'),
	};
}

// Helper to check if an event matches a keybinding
function matchesKeybinding(e: KeyboardEvent, keyStr: string): boolean {
	const parsed = parseKeyString(keyStr);
	return (
		e.key.toLowerCase() === parsed.key &&
		e.ctrlKey === parsed.ctrl &&
		e.shiftKey === parsed.shift &&
		e.altKey === parsed.alt &&
		e.metaKey === parsed.meta
	);
}

// Check and execute plugin keybindings
async function checkPluginKeybindings(e: KeyboardEvent, context: 'editor' | 'terminal' | 'global') {
	// Refresh cache if stale
	if (Date.now() - keybindingsCacheTime > KEYBINDINGS_CACHE_TTL) {
		await refreshPluginKeybindings();
	}

	for (const keybinding of pluginKeybindingsCache) {
		// Check if the keybinding matches the current context
		if (keybinding.when && keybinding.when !== context && keybinding.when !== 'global') {
			continue;
		}

		if (matchesKeybinding(e, keybinding.key)) {
			e.preventDefault();
			e.stopImmediatePropagation();

			// Execute the command via RPC
			try {
				await electrobun.rpc?.request.pluginExecuteCommand({
					commandId: keybinding.command,
					args: [],
				});
			} catch (err) {
				console.error('Failed to execute plugin command:', err);
			}
			break;
		}
	}
}

const canOpenNodeInNewTab = (nodePath: string) => {
	const draggedNode = getNode(nodePath);
	if (draggedNode) {
		// Allow files, folders with slates, or folders without slates (for terminal tabs)
		return draggedNode.type === "file" || draggedNode.type === "dir";
	}

	return false;
};

// Gets the workspace window for this window from state

const moveTabToPane = (
	tabId: string,
	targetPaneId: string,
	targetTabIndex: number,
) => {
	setState(
		produce((_state: AppState) => {
			const win = getWindow(_state);
			if (!win) {
				return;
			}
			const tab = win.tabs[tabId];
			const oldPane = getPaneWithId(_state, tab.paneId);

			if (oldPane?.type !== "pane") {
				return;
			}

			const index = oldPane.tabIds.indexOf(tabId);
			oldPane.tabIds = oldPane.tabIds.filter((id) => id !== tabId);

			const targetPane = getPaneWithId(_state, targetPaneId);
			if (targetPane?.type !== "pane") {
				return;
			}
			targetPane.tabIds.splice(targetTabIndex, 0, tabId);
			tab.paneId = targetPaneId;

			if (oldPane.currentTabId === tabId) {
				const newCurrentTabIndex = Math.max(
					0,
					Math.min(index - 1, oldPane.tabIds.length - 1),
				);
				oldPane.currentTabId = oldPane.tabIds[newCurrentTabIndex] || "";

				targetPane.currentTabId = tabId;
			}

			if (!targetPane.currentTabId) {
				targetPane.currentTabId = tabId;
			}
		}),
	);
	updateSyncedState();
};

// Context Menus
// right click onContextMenu in renderer -> send menu config via post message to node -> interact
// and send postMessage back with option selected -> use mapping to call the right function
// ephemeral mapping set whenever a context menu is opened
// let contextMenuCommands = null;

// todo (yoav): There's a better place for this
console.log("🟢 DEBUG: index.tsx module loaded and executing");

createEffect(() => {
	// clean up authUrl when settingsPane is closed
	if (!state.settingsPane.type && state.githubAuth.authUrl) {
		setState("githubAuth", { authUrl: null, resolver: null });
	}
});

function syncAllElectrobunWebviews() {
	document
		.querySelectorAll("electrobun-webview")
		.forEach((el: any) => el?.syncDimensions?.(true));
}

function createWebviewSyncBurst(durationMs = 250) {
	let rafId: number | null = null;

	const stop = () => {
		if (rafId !== null) {
			cancelAnimationFrame(rafId);
			rafId = null;
		}
	};

	const start = () => {
		stop();
		const startedAt = performance.now();

		const tick = () => {
			syncAllElectrobunWebviews();
			if (performance.now() - startedAt < durationMs) {
				rafId = requestAnimationFrame(tick);
			} else {
				rafId = null;
			}
		};

		tick();
	};

	return { start, stop };
}

const getInitialState = () => {
	console.log("renderer getInitialState - making RPC call...");

	if (!electrobun.rpc) {
		console.log(
			"renderer getInitialState - RPC not ready, retrying in 100ms...",
		);
		setTimeout(getInitialState, 100);
		return;
	}

	electrobun.rpc.request
		.getInitialState()
		.then(
			({
				windowId,
				buildVars,
				paths,
				peerDependencies,
				workspace,
				bunnyDash,
				projects,
				tokens,
				appSettings,
			}) => {
				console.log(
					"renderer getInitialState - received appSettings:",
					appSettings,
				);
				// todo: this is duplicated in setProjects. should be a util, maybe in goldfish
				const projectsById = projects?.reduce(
					(acc: Record<string, ProjectType>, project: ProjectType) => {
						acc[project.id] = project;
						// buildFileTree(project.path, true)
						return acc;
					},
					{},
				);
				setState({
					windowId,
					buildVars,
					paths,
					peerDependencies,
					workspace,
					bunnyDash,
					projects: projectsById,
					tokens,
					// Merge appSettings from database with existing defaults
					appSettings: appSettings
						? { ...state.appSettings, ...appSettings }
						: state.appSettings,
				});

				// Load plugin slates after initial state is set
				loadPluginSlates().catch((e) => {
					console.error("[index] Failed to load plugin slates:", e);
				});
			},
		)
		.catch((err) => {
			console.error("renderer getInitialState - error:", err);
		});
};

console.log("🔵 DEBUG: About to call getInitialState");
getInitialState();

const App = () => {
	// electrobun;
	//  -
	// ipcRenderer.on(
	//   "init-port",
	//   (e, { windowId, buildVars, paths, peerDependencies }) => {
	//     const port = e.ports[0];
	//     port.start();

	//     port.onmessage = ({ data: { type, data } }) => {
	//       switch (type) {
	//
	// ZZZ - exit fullscreen
	//         case "exit-full-screen-hack": {
	//           // NOTE: There's a bug where a webview iframe exiting full screen
	//           // doesn't exit the parent document's full screen and so you end up with
	//           // the whole webview rendering into the main window's #top-layer and
	//           // inside the window the exit fullscreen event isn't even fired.
	//           // So we have to listen for it here, and then trigger a document.exitFullscreen manually
	//           // on the parent document.

	//           // NOTE: We also have to wait for the exit full screen animation to finish before
	//           // triggering it on the main window. Otherwise it'll get stuck in fullscreen mode
	//           // 600ms is "enough" on my machine and 1200ms feels too long
	//           setTimeout(() => {
	//             document.exitFullscreen();
	//           }, 800);
	//           break;
	//         }

	//         default:
	//           throw new Error(`unexpected action: type:${type}`);
	//       }
	//     };

	//   }
	// );

	const githubAuthUrl = () => state.githubAuth.authUrl || "";

	// YYY - Electron.WebviewTag;
	let githubAuthWebview: any; //

	let shadowHost: HTMLDivElement | undefined;
	let shadowRoot: ShadowRoot;
	const settingsPaneWebviewSync = createWebviewSyncBurst(250);
	let previousSettingsPaneOpen = Boolean(state.settingsPane.type);

	createEffect(() => {
		const isSettingsPaneOpen = Boolean(state.settingsPane.type);
		if (isSettingsPaneOpen === previousSettingsPaneOpen) {
			return;
		}
		previousSettingsPaneOpen = isSettingsPaneOpen;
		settingsPaneWebviewSync.start();
	});

	// GitHub auth webview navigation handler
	const githubAuthWebviewWillNavigate = async (e: any) => {
		const { detail: url } = e;
		console.log("GitHub auth webview navigated to:", url);

		// For GitHub Personal Access Token flow, user manually creates token
		// We don't need to extract anything automatically, just let them navigate GitHub
		// They will copy the token and paste it in the settings form
	};

	onMount(() => {
		if (shadowHost) {
			shadowRoot = shadowHost.attachShadow({ mode: "open" });
			render(() => <Workbench />, shadowRoot);
		}

		// Listen for openFileInEditor events from the main process
		const handleOpenFileInEditor = async (e: CustomEvent<{ filePath: string; createIfNotExists?: boolean }>) => {
			const { filePath } = e.detail;
			const fileName = filePath.split('/').pop() || filePath;

			// Check if file is within a project
			const projects = Object.values(state.projects);
			const isInProject = projects.some(project =>
				filePath.startsWith(project.path + '/') || filePath === project.path
			);

			// For non-project files, we need to fetch the node and cache it first
			// since the FileWatcher doesn't track these files
			if (!state.fileCache[filePath]) {
				const node = await electrobun.rpc?.request.getNode({ path: filePath });
				if (node) {
					setState("fileCache", filePath, node);
				} else {
					// File doesn't exist or couldn't be accessed
					console.error('Could not get node for file:', filePath);
					return;
				}
			}

			if (!isInProject) {
				// Add to open files list
				addOpenFile(filePath, fileName, 'file');
			}

			// Defer opening the file to ensure state updates have propagated
			// This is needed because SolidJS state updates may be batched
			queueMicrotask(() => {
				openFileAt(filePath, 1, 1);
			});
		};

		// Listen for openFolderAsProject events from the main process
		const handleOpenFolderAsProject = async (e: CustomEvent<{ folderPath: string }>) => {
			const { folderPath } = e.detail;
			const folderName = folderPath.split('/').pop() || folderPath;

			// Check if project already exists
			const existingProject = Object.values(state.projects).find(p => p.path === folderPath);
			if (existingProject) {
				console.log('Project already exists:', folderPath);
				return;
			}

			// Add as a new project via RPC
			try {
				await electrobun.rpc?.request.addProject({
					projectName: folderName,
					path: folderPath,
				});
			} catch (err) {
				console.error('Failed to add project:', err);
			}
		};

		// Listen for removeOpenFile events from the main process (context menu)
		const handleRemoveOpenFile = (e: CustomEvent<{ filePath: string }>) => {
			const { filePath } = e.detail;
			removeOpenFile(filePath);
		};

		window.addEventListener('openFileInEditor', handleOpenFileInEditor as EventListener);
		window.addEventListener('openFolderAsProject', handleOpenFolderAsProject as EventListener);
		window.addEventListener('removeOpenFile', handleRemoveOpenFile as EventListener);
	});

	onCleanup(() => {
		settingsPaneWebviewSync.stop();
	});

	const [isLoaded, setIsLoaded] = createSignal(false);
	const [transitionLabelOverride, setTransitionLabelOverride] = createSignal<string | null>(null);
	let windowTransitionTimers: Array<ReturnType<typeof setTimeout>> = [];

	const buildWindowTransitionLabel = () => {
		const workspaceName = state.workspace?.name?.trim() || "Workspace";
		const currentLensId = state.bunnyDash?.currentLensId || "";
		const currentLens = state.bunnyDash?.workspaces
			?.flatMap((workspace) => workspace.lenses)
			.find((lens) => lens.id === currentLensId);
		if (!currentLens || currentLens.name === "Current") {
			return workspaceName;
		}
		return `${workspaceName} · ${currentLens.name}`;
	};

	const clearWindowTransitionTimers = () => {
		for (const timer of windowTransitionTimers) {
			clearTimeout(timer);
		}
		windowTransitionTimers = [];
	};

	const hideMountedWebSlatesForTransition = () => {
		const webSlates = document.querySelectorAll("electrobun-webview[data-type='webslate']");
		for (const webSlate of webSlates) {
			const element = webSlate as HTMLElement & {
				toggleTransparent?: (transparent?: boolean) => void;
			};
			try {
				element.toggleTransparent?.(true);
			} catch {}
			element.style.opacity = "0";
			element.style.visibility = "hidden";
			element.style.pointerEvents = "none";
		}
	};

	const beginWindowTransition = (label?: string) => {
		clearWindowTransitionTimers();
		setTransitionLabelOverride(label?.trim() || null);
		hideMountedWebSlatesForTransition();
		setIsLoaded(false);
	};

	const endWindowTransition = () => {
		clearWindowTransitionTimers();
		setIsLoaded(true);
		windowTransitionTimers.push(
			setTimeout(() => {
				setTransitionLabelOverride(null);
			}, 1000),
		);
	};

	const transitionLabel = createMemo(() => {
		const override = transitionLabelOverride()?.trim();
		if (override) {
			return override;
		}
		return buildWindowTransitionLabel();
	});

	onMount(() => {
		const handleBeginWindowTransition = (
			event: CustomEvent<{ label?: string }>,
		) => {
			beginWindowTransition(event.detail?.label);
		};
		const handleEndWindowTransition = () => {
			endWindowTransition();
		};
		window.addEventListener(
			"bunnyDashBeginWindowTransition",
			handleBeginWindowTransition as EventListener,
		);
		window.addEventListener(
			"bunnyDashEndWindowTransition",
			handleEndWindowTransition as EventListener,
		);
		windowTransitionTimers.push(
			setTimeout(() => {
				setIsLoaded(true);
			}, 1000),
		);
		onCleanup(() => {
			clearWindowTransitionTimers();
			window.removeEventListener(
				"bunnyDashBeginWindowTransition",
				handleBeginWindowTransition as EventListener,
			);
			window.removeEventListener(
				"bunnyDashEndWindowTransition",
				handleEndWindowTransition as EventListener,
			);
		});
	});

	// Drag and drop state
	const [isDraggingOver, setIsDraggingOver] = createSignal(false);
	let dragCounter = 0;

	const handleDragEnter = (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		// Disabled: Native file drag-and-drop is not supported in CEF/Chromium webviews
		// dragCounter++;
		// if (e.dataTransfer?.types.includes('Files')) {
		// 	setIsDraggingOver(true);
		// }
	};

	const handleDragLeave = (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounter--;
		if (dragCounter === 0) {
			setIsDraggingOver(false);
		}
	};

	const handleDragOver = (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (e.dataTransfer) {
			e.dataTransfer.dropEffect = 'copy';
		}
	};

	const handleDrop = async (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounter = 0;
		setIsDraggingOver(false);

		// NOTE: Native file drag-and-drop is not supported in CEF/Chromium webviews
		// because the browser doesn't expose full file paths for security reasons.
		// Users should use File > Open or the `edit` terminal command instead.
		// TODO: Implement native drop handling at the Electrobun/main process level
	};

	return (
		<div
			onDragEnter={handleDragEnter}
			onDragLeave={handleDragLeave}
			onDragOver={handleDragOver}
			onDrop={handleDrop}
				style={{
					height: "100vh", //"calc(100vh - 40px)",
					display: "flex",
					"flex-direction": "column",
					"-webkit-user-select": "none",
					position: "relative",
					background: "#000",

				// "align-items": "flex-start",
				// height: "100vh",
				// "border-width": "4px",
				// "border-top-width": "1px",
				// "border-style": "solid",
				// "border-color": state.workspace?.color || "#000",
				overflow: "hidden",
				"font-family":
					"Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif",
			}}
		>
			{/* Drop overlay */}
			<Show when={isDraggingOver()}>
				<div
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						right: 0,
						bottom: 0,
						background: "rgba(0, 120, 215, 0.2)",
						border: "3px dashed rgba(0, 120, 215, 0.8)",
						"border-radius": "8px",
						"z-index": 10000,
						display: "flex",
						"align-items": "center",
						"justify-content": "center",
						"pointer-events": "none",
					}}
				>
					<div
						style={{
							background: "rgba(0, 0, 0, 0.7)",
							color: "white",
							padding: "20px 40px",
							"border-radius": "8px",
							"font-size": "18px",
							"font-weight": "500",
						}}
					>
						Drop files to open or folders to add as projects
					</div>
				</div>
			</Show>
				<div
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						right: 0,
						bottom: 0,
						"z-index": 30000,
						display: "flex",
						"align-items": "center",
						"justify-content": "center",
						"pointer-events": "none",
						opacity: isLoaded() ? 0 : 1,
						transition: "opacity 1000ms ease",
					}}
				>
					<div
						style={{
							color: "#f3f3f3",
							"font-size": "22px",
							"font-weight": "600",
							"letter-spacing": "0.04em",
							"text-transform": "none",
							opacity: isLoaded() ? 0 : 1,
							transform: isLoaded() ? "translateY(8px)" : "translateY(0px)",
							transition: "opacity 300ms ease, transform 300ms ease",
						}}
					>
						{transitionLabel()}
					</div>
				</div>
				<div
					style={{
						display: "flex",
						"flex-direction": "column",
						height: "100%",
						opacity: isLoaded() ? 1 : 0,
						transition: "opacity 1000ms ease",
					}}
				>
					{/* Download notification is now shown in WebSlate URL bar */}
					<TopBar />
					<div
						style={{
							display: "flex",
							height: "calc(100vh - 40px - 22px)",
							overflow: "auto",
						}}
					>
						<Sidebar />
						<div
							style={{
								flex: 1,
								position: "relative",
								overflow: "hidden",
							}}
						>
							<div
								id="workbench-container"
								ref={shadowHost}
								style="width:100%; height: 100%"
							>
								<For each={Object.keys(getWindow()?.tabs || {})}>
									{(tabId) => <TabContent tabId={tabId} />}
								</For>
							</div>
							<div
								class="settings-pane webview-overlay"
								style={{
									background: "#404040",
									width: "500px",
									position: "absolute",
									top: "0px",
									bottom: "0px",
									left: state.settingsPane.type ? "0px" : "-514px",
									transition: "150ms left",
									"z-index": 1001,
								}}
							>
								<div style="position:absolute; right: -14px;border-left: 2px solid #212121; border-right: 2px solid #212121; background: #2b2b2b; width: 10px; height: 100%;" />
								<Show when={state.settingsPane.type}>
									<div style={{}}>
										<Switch>
											<Match when={state.settingsPane.type === "global-settings"}>
												<GlobalSettings />
											</Match>
											<Match
												when={state.settingsPane.type === "workspace-settings"}
											>
												<WorkspaceSettings />
											</Match>
											<Match when={state.settingsPane.type === "lens-settings"}>
												<LensSettings />
											</Match>
											<Match when={state.settingsPane.type.includes("node")}>
												<NodeSettings />
											</Match>
											<Match when={state.settingsPane.type === "llama-settings"}>
												<LlamaSettings />
											</Match>
											<Match when={state.settingsPane.type === "github-settings"}>
												<GitHubSettings />
											</Match>
											<Match when={state.settingsPane.type === "bunny-cloud-settings"}>
												<BunnyCloudSettings />
											</Match>
											<Match when={state.settingsPane.type === "plugin-marketplace"}>
												<PluginMarketplace />
											</Match>
											<Match when={state.settingsPane.type === "plugin-settings"}>
												<PluginSettings />
											</Match>
										</Switch>
									</div>
								</Show>
							</div>
							{githubAuthUrl() && (
								<electrobun-webview
									// nodeintegration={false}
									ref={(el) => {
										// YYY - el was Electron.WebviewTag type
										githubAuthWebview = el; // as Electron.WebviewTag;
										el.addEventListener(
											"did-navigate",
											githubAuthWebviewWillNavigate,
										);
									}}
									class="webview-overlay"
									partition={`persist:sites:${state.workspace.id}`}
									style={{
										position: "absolute",
										top: "0px",
										bottom: "0px", // Full height like settings pane
										left: "514px", // Start after settings pane (500px + 14px border)
										"z-index": 10,
										right: "0px",
										height: "auto",
										width: "auto",
										background: "#fff",
									}}
									src={githubAuthUrl()}
								/>
							)}
						</div>
					</div>
					<StatusBar />
					{/* Close Window Confirmation Dialog */}
					<Dialog
						isOpen={closeWindowDialogOpen}
						title="Close Window?"
						message={`You have ${Object.keys(getWindow()?.tabs || {}).length} open tab(s). Are you sure you want to close this window?`}
						onConfirm={confirmCloseWindow}
						onCancel={() => setCloseWindowDialogOpen(false)}
						confirmText="Close Window"
						cancelText="Cancel"
						type="danger"
					/>
				</div>
			</div>
		);
	};

// const SettingsPaneCollapsableSection = ({label}) => {
//   return ()
// }

const WorkspaceSettings = () => {
	const onClickDeleteWorkspace = () => {
		electrobun.rpc?.send.deleteWorkspace();
	};

	const onClickRemoveCompletely = () => {
		electrobun.rpc?.send.deleteWorkspaceCompletely();
	};

	let inputNameRef: HTMLInputElement | undefined;
	let inputColorRef: HTMLInputElement | undefined;

	const onSubmit = (e: SubmitEvent) => {
		e.preventDefault();

		if (inputNameRef && state.workspace?.name !== inputNameRef.value) {
			electrobun.rpc?.send.updateWorkspace({ name: inputNameRef.value });
		}

		if (inputColorRef && state.workspace?.color !== inputColorRef.value) {
			electrobun.rpc?.send.updateWorkspace({ color: inputColorRef.value });
		}
	};

	return (
		<div
			style={{
				background: "#404040",
				width: "100%",
				height: "100%",
				display: "flex",
				"flex-direction": "column",
				color: "#d9d9d9",
			}}
		>
			<form style="" onSubmit={onSubmit}>
				<SettingsPaneSaveClose label="Workspace Settings" />
				<div style="    display: flex;flex-direction: column;flex-grow: 1;overflow: auto overlay; border-top: 1px solid #212121">
					<div style="flex-grow: 1;align-self: stretch;    box-sizing: border-box;">
						<div>
							<div class="formbody">
								<div style="margin-top: 0px;background-color: transparent;border-left: 0px solid rgb(33, 33, 33);border-right: 0px solid rgb(33, 33, 33);border-radius: 0px;border-bottom: 1px solid rgb(33, 33, 33);">
									<SettingsPaneFormSection label="General">
										<SettingsPaneField label="Name">
											<SettingsInputField
												ref={inputNameRef}
												name="name"
												value={state.workspace?.name}
												placeholder={"Workspace Name"}
											/>
										</SettingsPaneField>
										<SettingsPaneField label="Color">
											<SettingsInputField
												ref={inputColorRef}
												name="color"
												value={state.workspace?.color}
												placeholder={"Workspace Color"}
											/>
										</SettingsPaneField>
									</SettingsPaneFormSection>
									<SettingsPaneFormSection label="Delete">
										<SettingsPaneField label="Delete Workspace">
											<button
												type="button"
												onClick={onClickDeleteWorkspace}
												style="cursor: pointer;background: #dd4444;color: white;font-weight: bold;border: none;padding: 10px;margin: 4px 0 8px;"
											>
												Remove from Bunny Dash only
											</button>

											<button
												type="button"
												onClick={onClickRemoveCompletely}
												style="cursor: pointer;background: #dd4444;color: white;font-weight: bold;border: none;padding: 10px;margin: 4px 0 8px;"
											>
												Remove from Bunny Dash and remove local files and folders
											</button>
											<span style="font-size: 11px;color: #999;background: #333;padding: 10px;">
												Will instantly delete all files and folders in all the
												projects in this workspace. They will go to the recycle
												bin.
											</span>
										</SettingsPaneField>
									</SettingsPaneFormSection>
								</div>
							</div>
						</div>
					</div>
				</div>
			</form>
		</div>

		// <div
		//   style={{
		//     background: "#fff",
		//     width: "100%",
		//     height: "100%",
		//   }}
		// >
		//   <h2>Tokens</h2>
		//   <For each={state.tokens}>
		//     {(token) => (
		//       <>
		//         <div>name: {token.name}</div>
		//         <div>url: {token.url}</div>
		//         <div>endpoint: {token.endpoint}</div>
		//         <div>token: {token.token}</div>
		//         <button onClick={() => onDeleteClick(token.id)}>delete</button>
		//         <span>
		//           This will delete it from Bunny Dash, but you may still need to revoke
		//           it in Webflow's settings
		//         </span>
		//       </>
		//     )}
		//   </For>
		// </div>
	);
};

const LensSettings = () => {
	const lensSettings = () => {
		if (state.settingsPane.type !== "lens-settings") {
			return null;
		}
		return state.settingsPane.data;
	};

	let inputNameRef: HTMLInputElement | undefined;
	let inputDescriptionRef: HTMLTextAreaElement | undefined;

	const applyInitialState = async () => {
		const response = await electrobun.rpc?.request.getInitialState();
		if (!response) {
			return;
		}

		const {
			windowId,
			buildVars,
			paths,
			peerDependencies,
			workspace,
			bunnyDash,
			projects,
			tokens,
			appSettings,
		} = response;

		const projectsById = projects?.reduce(
			(acc: Record<string, ProjectType>, project: ProjectType) => {
				acc[project.id] = project;
				return acc;
			},
			{},
		);

		setState({
			windowId,
			buildVars,
			paths,
			peerDependencies,
			workspace,
			bunnyDash,
			projects: projectsById,
			tokens,
			appSettings: appSettings
				? { ...state.appSettings, ...appSettings }
				: state.appSettings,
		});
	};

	createEffect(() => {
		const data = lensSettings();
		if (!data) {
			return;
		}

		if (inputNameRef) {
			inputNameRef.value = data.name;
		}
		if (inputDescriptionRef) {
			inputDescriptionRef.value = data.description || "";
		}
	});

	const onSubmit = (e: SubmitEvent) => {
		e.preventDefault();

		(async () => {
			const data = lensSettings();
			if (!data) {
				return;
			}

			const nextName = inputNameRef?.value?.trim() || data.name.trim();
			const nextDescription = inputDescriptionRef?.value?.trim() || "";
			if (!nextName) {
				inputNameRef?.focus();
				inputNameRef?.select();
				return;
			}

			if (data.mode === "create") {
				if (data.workspaceId === state.bunnyDash.currentWorkspaceId) {
					await syncWorkspaceNow();
				}
				await electrobun.rpc?.request.createLens({
					workspaceId: data.workspaceId,
					name: nextName,
					description: nextDescription,
					sourceLensId: data.sourceLensId,
				});
			} else if (data.lensId) {
				await electrobun.rpc?.request.renameLens({
					lensId: data.lensId,
					name: nextName,
					description: nextDescription,
				});
			}

			await applyInitialState();
			setState("settingsPane", { type: "", data: {} });
		})();
	};

	const saveDisabled = () => {
		const data = lensSettings();
		if (!data) {
			return true;
		}
		return !(inputNameRef?.value?.trim() || data.name.trim());
	};

	return (
		<div
			style={{
				background: "#404040",
				width: "100%",
				height: "100%",
				display: "flex",
				"flex-direction": "column",
				color: "#d9d9d9",
			}}
		>
			<form onSubmit={onSubmit}>
				<SettingsPaneSaveClose
					label={lensSettings()?.mode === "rename" ? "Rename Lens" : "New Lens"}
					saveDisabled={saveDisabled}
				/>
				<div style="display: flex;flex-direction: column;flex-grow: 1;overflow: auto overlay; border-top: 1px solid #212121">
					<div style="flex-grow: 1;align-self: stretch; box-sizing: border-box;">
						<div class="formbody">
							<div style="margin-top: 0px;background-color: transparent;border-left: 0px solid rgb(33, 33, 33);border-right: 0px solid rgb(33, 33, 33);border-radius: 0px;border-bottom: 1px solid rgb(33, 33, 33);">
								<SettingsPaneFormSection
									label={lensSettings()?.mode === "rename" ? "Lens" : "Create Lens"}
								>
									<SettingsPaneField label="Name">
										<input
											ref={(el) => {
												inputNameRef = el;
											}}
											type="text"
											name="name"
											value={lensSettings()?.name || ""}
											placeholder="Lens name"
											style="background: #2b2b2b;border-radius: 2px;border: 1px solid #212121;color: #d9d9d9;outline: none;cursor: text;display: block;font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;font-size: 12px;padding-top: 8px;padding-right: 9px;padding-bottom: 8px;padding-left: 9px;line-height: 14px;width: 100%;box-sizing: border-box;"
										/>
									</SettingsPaneField>
									<SettingsPaneField label="Description">
										<textarea
											ref={(el) => {
												inputDescriptionRef = el;
											}}
											name="description"
											placeholder="Optional description"
											style="background: #2b2b2b;border-radius: 2px;border: 1px solid #212121;color: #d9d9d9;outline: none;cursor: text;display: block;font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;font-size: 12px;padding-top: 8px;padding-right: 9px;padding-bottom: 8px;padding-left: 9px;line-height: 16px;min-height: 96px;resize: vertical;width: 100%;box-sizing: border-box;"
										>
											{lensSettings()?.description || ""}
										</textarea>
									</SettingsPaneField>
								</SettingsPaneFormSection>
							</div>
						</div>
					</div>
				</div>
			</form>
		</div>
	);
};

const GlobalSettings = () => {
	const [analyticsEnabled, setAnalyticsEnabled] = createSignal(
		state.appSettings.analyticsEnabled || false,
	);
	const [analyticsStatus, setAnalyticsStatus] = createSignal<any>({});

	// Load current analytics status
	onMount(() => {
		// Use actual values from state, but provide reasonable defaults for display
		setAnalyticsStatus({
			enabled: state.appSettings.analyticsEnabled || false,
			level: "Community", // Most users start as community
			isAnonymous: true, // Community users are anonymous
			hasToken: false, // Dev builds typically don't have tokens
			userOptedIn: state.appSettings.analyticsEnabled || false,
			userHasBeenPrompted: state.appSettings.analyticsConsentPrompted || false,
		});
		setAnalyticsEnabled(state.appSettings.analyticsEnabled || false);
	});

	const onDeleteClick = (tokenId: string) => {
		electrobun.rpc?.send.deleteToken({ tokenId });
	};

	const onSubmit = (e: SubmitEvent) => {
		e.preventDefault();

		// Save analytics settings to state and database
		setState("appSettings", {
			analyticsEnabled: analyticsEnabled(),
			analyticsConsentPrompted: true,
		});

		// Persist changes to database
		updateSyncedAppSettings();

		console.log(`Analytics consent set to: ${analyticsEnabled()}`);

		// Close settings
		setState("settingsPane", { type: "", data: {} });
	};

	return (
		<div
			style={{
				background: "#404040",
				width: "100%",
				height: "100%",
				display: "flex",
				"flex-direction": "column",
				color: "#d9d9d9",
			}}
		>
			<form style="" onSubmit={onSubmit}>
				<SettingsPaneSaveClose label="Global Settings" />
				<div style="    display: flex;flex-direction: column;flex-grow: 1;overflow: auto overlay; border-top: 1px solid #212121">
					<div style="flex-grow: 1;align-self: stretch;    box-sizing: border-box;">
						<div>
							<div class="formbody">
								<div style="margin-top: 0px;background-color: transparent;border-left: 0px solid rgb(33, 33, 33);border-right: 0px solid rgb(33, 33, 33);border-radius: 0px;border-bottom: 1px solid rgb(33, 33, 33);">
									<SettingsPaneFormSection label="Tokens">
										<For each={state.tokens}>
											{(token) => (
												<>
													{/* <div class="field" style="margin-top: 8px;">
                            <div style="display: flex;flex-direction: column;">
                              <div
                                class="field-head"
                                style="display: flex;-webkit-box-align: end;-ms-flex-align: end;align-items: flex-end;-ms-flex-wrap: wrap;flex-wrap: wrap;margin-bottom: 8px;"
                              >
                                <div style="box-sizing: border-box;color: rgb(217, 217, 217);cursor: default;display: block;font-family: Inter, -apple-system, 'system-ui', 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;font-size: 12px;height: 16px;line-height: 16px;max-width: 100%;overflow-x: hidden;overflow-y: hidden;pointer-events: auto;text-overflow: ellipsis;text-size-adjust: 100%;user-select: text;white-space: nowrap;">
                                  Name
                                </div>
                              </div>
                              <input
                                type="text"
                                // ref={inputNameRef}
                                name="name"
                                // onInput={onNameChange}
                                placeholder={"New Project Name"}
                                style="background: #2b2b2b;border-radius: #2b2b2b;border: 1px solid #212121;color: #d9d9d9;outline: none;cursor: text;display: block;font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;font-size: 12px;padding-top: 8px;padding-right: 9px;padding-bottom: 8px;padding-left: 9px;line-height: 14px;"
                              ></input>
                            </div>
                          </div> */}
													<SettingsPaneField label="name">
														<SettingsReadonlyField
															label="name"
															value={token.name}
														/>
														<SettingsReadonlyField
															label="url"
															value={token.url}
														/>
														<SettingsReadonlyField
															label="endpoint"
															value={token.endpoint}
														/>
														<SettingsReadonlyField
															label="token"
															value={token.token}
														/>
														<button
															style="cursor: pointer;background: #dd4444;color: white;font-weight: bold;border: none;padding: 10px;margin: 4px 0 8px;"
															onClick={() => onDeleteClick(token.id)}
														>
															delete
														</button>
														<span style="font-size: 11px;color: #999;background: #333;padding: 10px;">
															This will delete the token from Bunny Dash, but you
															may still need to revoke it in Webflow's settings
														</span>
													</SettingsPaneField>
												</>
											)}
										</For>
									</SettingsPaneFormSection>
								</div>
								<div style="margin-top: 0px;background-color: transparent;border-left: 0px solid rgb(33, 33, 33);border-right: 0px solid rgb(33, 33, 33);border-radius: 0px;border-bottom: 1px solid rgb(33, 33, 33);">
									<AnalyticsSettingsSection
										analyticsEnabled={analyticsEnabled}
										setAnalyticsEnabled={setAnalyticsEnabled}
										analyticsStatus={analyticsStatus}
									/>
								</div>
							</div>
						</div>
					</div>
				</div>
			</form>
		</div>

		// <div
		//   style={{
		//     background: "#fff",
		//     width: "100%",
		//     height: "100%",
		//   }}
		// >
		//   <h2>Tokens</h2>
		//   <For each={state.tokens}>
		//     {(token) => (
		//       <>
		//         <div>name: {token.name}</div>
		//         <div>url: {token.url}</div>
		//         <div>endpoint: {token.endpoint}</div>
		//         <div>token: {token.token}</div>
		//         <button onClick={() => onDeleteClick(token.id)}>delete</button>
		//         <span>
		//           This will delete it from Bunny Dash, but you may still need to revoke
		//           it in Webflow's settings
		//         </span>
		//       </>
		//     )}
		//   </For>
		// </div>
	);
};

const AnalyticsSettingsSection = ({
	analyticsEnabled,
	setAnalyticsEnabled,
	analyticsStatus,
}: {
	analyticsEnabled: Accessor<boolean>;
	setAnalyticsEnabled: (value: boolean) => void;
	analyticsStatus: Accessor<any>;
}): JSXElement => {
	const [hasBeenPrompted, setHasBeenPrompted] = createSignal(false);

	return (
		<SettingsPaneFormSection label="Privacy & Analytics">
			<div style="margin-bottom: 16px;">
				<p style="color: rgb(204, 204, 204); font-size: 14px; line-height: 1.4; margin: 0 0 16px 0;">
					Help improve Bunny Dash by sharing anonymous usage data. This data helps us
					understand how features are used and identify issues.
				</p>

				<div style="background: rgb(45, 45, 45); border: 1px solid rgb(70, 70, 70); border-radius: 4px; padding: 16px; margin-bottom: 16px;">
					<h4 style="margin: 0 0 8px 0; color: rgb(235, 235, 235); font-size: 14px;">
						What data is collected?
					</h4>
					<ul style="margin: 0; padding-left: 16px; color: rgb(204, 204, 204); font-size: 13px;">
						<li>App launches and version information</li>
						<li>Crash reports (with personal paths removed)</li>
						<li>Anonymous feature usage patterns</li>
						<li>Performance metrics</li>
					</ul>

					<h4 style="margin: 16px 0 8px 0; color: rgb(235, 235, 235); font-size: 14px;">
						What is NOT collected?
					</h4>
					<ul style="margin: 0; padding-left: 16px; color: rgb(204, 204, 204); font-size: 13px;">
						<li>File contents or code</li>
						<li>Personal information</li>
						<li>File names or paths</li>
						<li>Keystrokes or passwords</li>
					</ul>
				</div>
			</div>

			<SettingsPaneField label="Share Anonymous Usage Data">
				<label style="display: flex; align-items: center; cursor: pointer;">
					<input
						type="checkbox"
						checked={analyticsEnabled()}
						onChange={(e) => setAnalyticsEnabled(e.target.checked)}
						style="margin-right: 8px;"
					/>
					<span style="color: rgb(204, 204, 204); font-size: 14px;">
						Enable analytics to help improve Bunny Dash
					</span>
				</label>
			</SettingsPaneField>

			<div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid rgb(70, 70, 70);">
				<div style="color: rgb(170, 170, 170); font-size: 12px;">
					<div style="margin-bottom: 4px;">
						<strong>Current Status:</strong>{" "}
						{analyticsStatus().enabled ? "Enabled" : "Disabled"}
					</div>
					<div style="margin-bottom: 4px;">
						<strong>Data Level:</strong>{" "}
						{analyticsStatus().level || "Community"} (
						{analyticsStatus().isAnonymous ? "Anonymous" : "Account-linked"})
					</div>
					<div style="margin-bottom: 4px;">
						<strong>Token Available:</strong>{" "}
						{analyticsStatus().hasToken ? "Yes" : "No"}
					</div>
					{hasBeenPrompted() && (
						<div style="margin-top: 8px; font-style: italic;">
							You can change this setting anytime.
						</div>
					)}
				</div>
			</div>
		</SettingsPaneFormSection>
	);
};

const getContainerCSS = (container: LayoutContainerType, index: number) => {
	const value = `${index === 0 ? container.divider : 100 - container.divider}%`;

	return container.direction === "row"
		? {
				display: "flex",
				"flex-grow": 1,
				width: value,
				height: "100%",
		  }
		: {
				display: "flex",
				"flex-grow": 1,
				width: "100%",
				height: value,
		  };
};

const PaneContainerComponent = ({
	container,
	pathToPane,
	paneStyles,
}: {
	container: () => LayoutContainerType;
	pathToPane: PanePathType;
	paneStyles: () => JSX.CSSProperties;
}) => {
	return (
		<div
			class="workbench"
			style={{
				"flex-direction": container().direction,
				position: "relative",
				...paneStyles(),
			}}
		>
			<For each={container().panes}>
				{(pane, childIndex) => {
					console.log("pathToPane", pathToPane, childIndex());
					return (
						<>
							<Show when={childIndex() > 0}>
								<PaneDivider
									paneContainer={container()}
									pathToPane={[...pathToPane, childIndex()]}
								/>
							</Show>
							<LayoutComponent
								paneOrContainer={() => pane}
								pathToPane={[...pathToPane, childIndex()]}
								paneStyles={() => getContainerCSS(container(), childIndex())}
								parentSplitDirection={container().direction}
							/>
						</>
					);
				}}
			</For>
		</div>
	);
};

// const WorkbenchPane = ({ $pane, index, pathToPane }) => {
//   return (
//     <div
//       class="workbenchpane"
//       style={{ display: "flex", width: "100%", height: "100%" }}
//     >
//       <Pane pane={$pane} index={index} pathToPane={pathToPane} />
//     </div>
//   );
// };

const Workbench = () => {
	return (
		<Show when={"type" in (getRootPane(state) || {})}>
			<LayoutComponent
				paneOrContainer={getRootPane as () => PaneLayoutType}
				paneStyles={() => ({ display: "flex", width: "100%", height: "100%" })}
			/>
		</Show>
	);
};

const LayoutComponent = ({
	paneOrContainer,
	pathToPane = [],
	paneStyles,
	parentSplitDirection,
}: {
	paneOrContainer: () => PaneLayoutType;
	pathToPane?: PanePathType;
	paneStyles: () => JSX.CSSProperties;
	parentSplitDirection?: "row" | "column";
}) => {
	// const _paneOrContainer = () => paneOrContainer;

	return (
		<>
			<style type="text/css">
				{`
::slotted(*) {
  display: block !important;
}

*::-webkit-scrollbar {
  display: none;
}
/* this targets tabs inside the pane shadowdoms, but not the draggable proxy of it which is 
on the main document */
[data-isdragging="true"] {
  display: none!important;
 }

`}
			</style>

			<Switch>
				<Match when={paneOrContainer().type === "container"}>
					<PaneContainerComponent
						container={paneOrContainer as () => LayoutContainerType}
						pathToPane={pathToPane}
						paneStyles={paneStyles}
					/>
				</Match>
				<Match when={paneOrContainer().type === "pane"}>
					<Pane
						pane={paneOrContainer() as LayoutPaneType}
						pathToPane={pathToPane}
						paneStyles={paneStyles}
						parentSplitDirection={parentSplitDirection}
					/>
				</Match>
			</Switch>
		</>
	);
};

const PaneDivider = ({
	paneContainer,
	pathToPane,
}: {
	paneContainer: LayoutContainerType;
	pathToPane: PanePathType;
}) => {
	const [isDragging, setIsDragging] = createSignal(false);
	const [isHovered, setIsHovered] = createSignal(false);

	// todo (yoav): just use paneContainer.divider instead of a walk
	const [targetPercent, setTargetPercent] = createSignal(paneContainer.divider);

	const toggleIsDragging = (
		e: DomEventWithTarget<MouseEvent>,
		value: boolean,
	) => {
		if (e.button !== 0) {
			return;
		}

		setIsDragging(value);
		setState("isResizingPane", value);
	};

	const onMouseMove = (e: DomEventWithTarget<MouseEvent>) => {
		if (!isDragging()) {
			return;
		}

		if (!e.currentTarget.parentElement) {
			return;
		}

		const amountMoved =
			paneContainer.direction === "row" ? e.movementX : e.movementY;
		const percentMoved =
			(amountMoved / e.currentTarget.parentElement.clientWidth) * 90;
		setTargetPercent(targetPercent() + percentMoved);

		setState(
			produce((_state: AppState) => {
				const rootPane = getRootPane(_state);
				if (!rootPane) {
					return;
				}

				const pane = walkPanesForId(rootPane, paneContainer.id);

				if (pane?.type !== "container") {
					return;
				}

				pane.divider = targetPercent();
			}),
		);
	};
	const isRow = paneContainer.direction === "row";
	const thickness = 4; //(isHovered() ? 8 : 8);
	// const percent = () => targetPercent
	const onContextMenu = (e: DomEventWithTarget<MouseEvent>) => {
		e.preventDefault();

		electrobun.rpc?.request.showContextMenu({
			menuItems: [
				{
					label: `Split ${isRow ? "Horizontally" : "Vertically"}`,
					...createContextMenuAction("split_pane_container", {
						pathToPane: pathToPane,
						direction: isRow ? "row" : "column",
					}),
				},
			],
		});
	};

	// const animationTime = 500;

	const styles: () => JSX.CSSProperties = () => ({
		cursor: isRow ? "ew-resize" : "ns-resize",
		width: isRow ? `${thickness}px` : "100%",
		height: isRow ? "100%" : `${thickness}px`,
		transition: "background 150ms, box-shadow 150ms",
		left: 0,
		top: 0,
		"z-index": 20,
		background: isHovered() ? "#105460" : "#181818",
		"box-shadow":
			"inset 0 2px 4px rgba(0,0,0,0.4), inset 0 -2px 4px rgba(0,0,0,0.4)",
	});

	return (
		<div
			style="z-index:2;-webkit-user-select: none; cusor: move;"
			onContextMenu={onContextMenu}
			onMouseDown={(e) => toggleIsDragging(e, true)}
			onMouseUp={(e) => toggleIsDragging(e, false)}
			onMouseMove={onMouseMove}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
		>
			<div
				style={{
					display: isDragging() ? "block" : "none",
					position: "absolute",
					cursor: isRow ? "ew-resize" : "ns-resize",
					top: 0,
					right: 0,
					bottom: 0,
					left: 0,
					opacity: 0,
				}}
			/>
			<div style={styles()} />
		</div>
	);
};

// ClosePane closes the pane and moves the tabs to the nearest sibling or parent pane
// If you want to also close all tabs in the closing pane then you need to do that before calling this

// This does two things:
// 1. It finds the pane whose close button was clicked and promotes its sibling which is either a pane or container
// to replace their parent which is either a container or the root container
// 2. it takes the tabs from the pane being closed (if any) and moves them to the nearest sibling or nephew pane
const closePane = (pathToPane: PanePathType) => {
	setState(
		produce((_state: AppState) => {
			const win = getWindow(_state);
			let currentPane = getRootPane(_state);

			if (!win) {
				return;
			}

			// Grandparent can only be a window or pane container, if it was a pane
			// it would be a terminal leaf node and not a parent or grandparent
			let grandParent: WindowType | LayoutContainerType = win;
			let parentIndex = 0;

			for (let i = 0; i < pathToPane.length; i++) {
				const childIndex = pathToPane[i];
				if (i !== pathToPane.length - 1) {
					// drill down setting the pane to its child
					grandParent = currentPane as LayoutContainerType;
					currentPane = grandParent.panes[childIndex];
				} else {
					const parentPane = currentPane as LayoutContainerType;
					currentPane = parentPane.panes[childIndex];
					const paneToClose = currentPane as LayoutPaneType;
					const siblingIndex = childIndex ? 0 : 1;
					const newphewIndex = childIndex ? 1 : 0;
					const sibling = parentPane.panes[siblingIndex];
					let targetTabPane = sibling;

					// sibling could be a container, so drill down until we hit a pane
					while (targetTabPane.type !== "pane") {
						// todo (yoav): add the ability to 'lean left' or 'left right' (or up or down) when drilling down
						targetTabPane = targetTabPane.panes[newphewIndex];
					}

					if (grandParent === win) {
						win.rootPane = sibling;
					} else {
						// Note: we know that if the grandparent isn't the window then we're not
						// closing the top-level container, so the grandparent must be a LayoutContainerType
						// The parent won't ever be the window because when that's true we don't expose
						// the x button to close the pane. and the pathToPane will have no length
						// and this will never run
						(grandParent as LayoutContainerType).panes[parentIndex] = sibling;
					}

					if (win.currentPaneId === paneToClose.id) {
						win.currentPaneId = targetTabPane.id;
					}

					paneToClose.tabIds.forEach((tabId) => {
						const tab = win.tabs[tabId];
						tab.paneId = targetTabPane.id;
					});

					targetTabPane.tabIds = [
						...targetTabPane.tabIds,
						...paneToClose.tabIds,
					];

					if (targetTabPane.currentTabId === null && targetTabPane.tabIds) {
						targetTabPane.currentTabId = targetTabPane.tabIds[0];
					}
					// }
				}
				parentIndex = childIndex;
			}
		}),
	);
	updateSyncedState();
};

// todo (yoav): [blocking] rename Pane type to PaneType
const Pane = ({
	pane,
	pathToPane,
	paneStyles,
	parentSplitDirection,
}: {
	pane: LayoutPaneType;
	pathToPane: PanePathType;
	paneStyles: () => JSX.CSSProperties;
	parentSplitDirection?: "row" | "column";
}) => {
	// const currentTab = () => getWindow().tabs[pane.currentTab];
	const [isTabsExpanded, setIsTabsExpanded] = createSignal(false);

	// todo (yoav): add a debounce to the tab show/hide so that rolling over it expands in and it only hides if you mouse out and stay out for a bit

	const onHorizontalSplitClick = () => {
		splitPane(pathToPane, "row");
	};
	const onVerticalSplitClick = () => {
		splitPane(pathToPane, "column");
	};
	const onCloseSplitClick = () => {
		closePane(pathToPane);
	};

	const isSelected = () => pane.id === getWindow()?.currentPaneId;

	const onPaneClick = () => {
		if (!isSelected()) {
			const winIndex = state.workspace?.windows?.findIndex(
				(w) => w.id === state.windowId,
			);
			// todo (yoav): create an setWindowState function
			setState("workspace", "windows", winIndex, "currentPaneId", pane.id);
		}
	};

	// const [showDropTarget, setShowDropTarget] = createSignal(false);
	let paneRef;

	const renderDropTarget = () => Boolean(state.dragState);
	const isDropTarget = () => state.dragState?.targetPaneId === pane.id;
	const isEmptyPane = () => !pane.tabIds.length;

	// Removed isAddTabBtnHovered state - no longer needed without new tab button

	const paneSiblingIndex = pathToPane[pathToPane.length - 1];
	const paneJoinIcon =
		parentSplitDirection === "row"
			? paneSiblingIndex === 0
				? "horizontal-join-right"
				: "horizontal-join-left"
			: paneSiblingIndex === 0
			  ? "vertical-join-down"
			  : "vertical-join-up";

	// Removed isDroppingTabAtEnd - was only used by the new tab button

	return (
		<div
			ref={paneRef}
			onDragEnter={(e) => {
				if (!isDropTarget()) {
					if (!state.dragState?.type) {
						return;
					}

					const { type } = state.dragState;

					// todo (yoav): add a util for determining if a node can be opened in a new tab
					if (type === "tab" || canOpenNodeInNewTab(state.dragState.nodePath)) {
						const { targetPaneId } = state.dragState;
						if (targetPaneId !== pane.id) {
							setState(
								produce((_state: AppState) => {
									const { dragState } = _state;

									if (dragState) {
										dragState.targetPaneId = pane.id;

										if (pane.tabIds.includes(dragState.id)) {
											dragState.targetTabIndex = pane.tabIds.length - 1;
										} else {
											dragState.targetTabIndex = pane.tabIds.length;
										}

										if ("targetFolderPath" in dragState) {
											dragState.targetFolderPath = null;
										}
									}
								}),
							);
						}
					}
				}
				// todo (yoav): rewrite this to go based on targetPaneId
				// setShowDropTarget(true);
			}}
			onDragOver={(e) => {
				// This removes the animation when dragging is finished where the
				// drag preview slowly animates back to the original location
				e.preventDefault();
			}}
			// onDragLeave={(e) => {
			//   // when dragging outside the pane
			//   if (!e.currentTarget.contains(e.relatedTarget)) {
			//     if (showDropTarget()) {
			//       // setState("dragState", "targetPaneId", null);
			//     }
			//   }
			// }}
			onMouseDown={onPaneClick}
			style={{
				display: "flex",
				// "flex-direction": pane.direction,
				width: "100%",
				height: "100%",
				"box-sizing": "border-box",

				...paneStyles(),
			}}
		>
			<div
				class="pane-content"
				style={{
					width: "100%",
					display: "flex",
					"flex-direction": "column",
				}}
			>
				<div
					class="pane-top-bar"
					style={{
						height: isTabsExpanded() ? "30px" : "30px",
						width: "100%",
						display: "flex",
						transition: "height 0.4s",
						"overflow-y": "hidden",
						background: isSelected() ? "#272729" : "#252526",
						opacity: isSelected() ? 1 : 0.75,
					}}
					onMouseEnter={() => setIsTabsExpanded(true)}
					onMouseLeave={() => setIsTabsExpanded(false)}
				>
					<div
						class="pane-tab-container"
						style="display:flex; width:100%;overflow-x: scroll;overflow-y:hidden;align-items: center;"
					>
						<For each={pane.tabIds}>
							{(tabId, index) => (
								<PaneTab
									tabId={tabId}
									index={index}
									pathToPane={pathToPane}
									paneId={pane.id}
								/>
							)}
						</For>
						{/* Removed new tab button - all web tabs must now be connected to a folder node */}
					</div>
					<div
						class="pane-split-controls"
						style="display:flex; align-items:center; box-shadow: -2px 0px 4px 2px #222; z-index: 1;"
					>
						<Show when={getRootPane()?.type === "container"}>
							<button
								onClick={onCloseSplitClick}
								style="background: #333;border: 1px solid #111;margin: 2px;color: #fff;display:flex; align-items:center; justify-content: center;"
							>
								<img
									width="18px"
									height="18px"
									src={`views://assets/file-icons/${paneJoinIcon}.svg`}
								/>
							</button>
						</Show>
						<button
							onClick={onHorizontalSplitClick}
							style="background: #333;border: 1px solid #111;margin: 2px;color: #fff;display:flex; align-items:center; justify-content:center;"
						>
							<img
								width="18px"
								height="18px"
								src={"views://assets/file-icons/horizontal-split-right.svg"}
							/>
						</button>
						<button
							onClick={onVerticalSplitClick}
							style="background: #333;border: 1px solid #111;margin: 2px;color: #fff;display:flex; align-items:center; justify-content: center;"
						>
							<img
								width="18px"
								height="18px"
								src={"views://assets/file-icons/vertical-split-down.svg"}
							/>
						</button>
					</div>
				</div>

				<div
					style={{
						position: "relative",
						width: "100%",
						background: isEmptyPane() ? "#000005" : "",

						// height: "calc(100% - 25px)",
						"flex-grow": 1,
					}}
				>
					<For each={pane.tabIds}>
						{(tabId) => (
							<div style={{
								position: "absolute",
								inset: "0",
								display: tabId === pane.currentTabId ? "block" : "none",
								"pointer-events": tabId === pane.currentTabId && !renderDropTarget() ? "auto" : "none",
							}}>
								<slot name={`paneslot-${tabId}`} />
							</div>
						)}
					</For>
					<Show when={isEmptyPane()}>
						<div
							style={{
								position: "absolute",
								top: "50%",
								left: "50%",
								transform: "translate(-50%, -50%)",
								"font-size": "36px",
								"font-weight": "600",
								"font-family":
									"Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
								color: "#131212ff",
								"user-select": "none",
								"pointer-events": "none",
								"z-index": 1,
								"letter-spacing": "1px",
							}}
						>
							Bunny Dash
						</div>
						<BlackboardAnimation />
					</Show>
					<div
						style={{
							display: isDropTarget() ? "flex" : "none",
							"z-index": "100",
							background: "rgba(0, 0, 0, 0.95)",
							// opacity: state.isResizingPane ? 0.95 : 1,
							position: "absolute",
							inset: "0px",
							"justify-content": "center",
							"align-items": "center",
						}}
					>
						<span style="color: #bbb">{"Drop Here"}</span>
					</div>
				</div>
			</div>
		</div>
	);
};

const TabContent = ({ tabId }: { tabId: string }) => {
	// todo (yoav): we might have two windows loading at the same time.
	// we should get this by tabId directly
	const tab = () => getWindow()?.tabs[tabId];

	// todo (yoav): rename pane and tab slots to make it more obvious what id is used
	const paneSlot = () => `paneslot-${tab()?.id}`;

	// todo (yoav): add a preload script to the webview wired up with typescript
	// ideally we could inline it so allow dynamic scripts based on the url.
	// maybe it just calls back with certain events.
	// alternatively if you can get the dashboard replay code with overlayer for events to work
	// that would be best
	const setActivePane = () => {
		const tabPaneId = tab()?.paneId;
		if (!tabPaneId) {
			return;
		}

		if (getWindow()?.currentPaneId !== tabPaneId) {
			const winIndex = state.workspace?.windows?.findIndex(
				(w) => w.id === state.windowId,
			);
			// todo (yoav): create an setWindowState function
			setState("workspace", "windows", winIndex, "currentPaneId", tabPaneId);
			// getWindow().currentPaneId = tab().paneId;
			// setState("currentPaneId", tab().paneId);
		}
	};

	// const _tab = tab();

	return (
		<div
			class="tabcontent"
			data-tabId={tabId}
			slot={paneSlot()}
			style={{
				height: "100%",
				width: "100%",
				background: "#1f1f1f",
				color: "#fff",
				position: "absolute",
			}}
			onMouseDown={setActivePane}
		>
			<Switch>
				<Match when={tab()?.type === "file" && !getNode(tab()?.path)}>
					<div>
						The file for this tab was deleted, renamed, or moved outside of
						Bunny Dash and no longer exists
					</div>
				</Match>
				<Match when={tab()?.type === "terminal"}>
					<TerminalSlate tabId={tabId} />
				</Match>
				<Match
					when={Boolean(tab()?.path?.match(/.+\.(png|jpg|jpeg|gif|webp)$/))}
				>
					<electrobun-webview
						partition="persist:sites:webflow"
						style={{
							height: "100%",
							background: "#fff",
						}}
						src={tab()?.path}
						// preload=""
					/>
				</Match>

				{/* Force editor - bypass slate rendering when forceEditor is true */}
				<Match when={(tab() as FileTabType)?.forceEditor && getNode(tab()?.path)?.type === "file"}>
					<Editor currentTabId={(tab() as FileTabType)?.id} />
				</Match>

				{/* Plugin slates - check plugin-registered slates before built-in slates */}
				<Match when={(() => {
					const node = getNode(tab()?.path);
					if (!node?.path) return null;
					return findPluginSlateForFile(node.path);
				})()}>
					{(pluginSlate) => (
						<PluginSlate
							node={getNode(tab()?.path)}
							slateInfo={pluginSlate() as PluginSlateInfo}
						/>
					)}
				</Match>

				{/* Slate-specific matches must come before generic file match */}
				<Match when={getSlateForNode(getNode(tab()?.path))?.type === "web"}>
					<WebSlate node={getNode(tab()?.path)} tabId={tabId} />
				</Match>
				<Match when={getSlateForNode(getNode(tab()?.path))?.type === "agent"}>
					<AgentSlate node={getNode(tab()?.path)} tabId={tabId} />
				</Match>
				<Match when={getSlateForNode(getNode(tab()?.path))?.type === "git"}>
					<GitSlate node={getNode(tab()?.path)} />
				</Match>

				{/* Generic file editor - must come after slate-specific matches */}
				<Match when={getNode(tab()?.path)?.type === "file"}>
					<Editor currentTabId={(tab() as FileTabType)?.id} />
				</Match>
			</Switch>
		</div>
	);
};

const getIconForTab = (tab: TabType | undefined): string => {
	if (!tab) {
		return "";
	}

	if (tab.type === "terminal") {
		// Return terminal icon for terminal tabs
		return "views://assets/file-icons/terminal.svg";
	}

	if (tab.path === "__BUNNY_INTERNAL__/web") {
		// Return a default globe icon for web tabs
		return "views://assets/file-icons/bookmark.svg";
	}

	if (tab.path) {
		const node = getNode(tab.path);
		if (node) {
			return getIconForNode(node);
		}
	}

	return "";
};

// Removed PaneTabDropTarget component - was only used by the new tab button

const PaneTab = ({
	tabId,
	index,
	pathToPane,
	paneId,
}: {
	tabId: string;
	index: Accessor<number>;
	pathToPane: PanePathType;
	paneId: string;
}) => {
	const [isDragging, setIsDragging] = createSignal(false);
	const [hideWileDragging, setHideWhileDragging] = createSignal(false);
	const tab = () => {
		return getWindow()?.tabs[tabId];
	};

	const [title, setTitle] = createSignal("");

	createEffect(() => {
		const _tab = tab();
		if (_tab?.type === "web") {
			// Track both URL and title to trigger updates when either changes
			const url = _tab.url;
			const pageTitle = _tab.title;
			console.log("PaneTab effect - URL:", url, "Title:", pageTitle);

			if (pageTitle) {
				// Use the page title if available
				setTitle(pageTitle);
			} else {
				// Fallback to hostname if no title yet
				const hostname = new URL(url).hostname;
				const hostnameParts = hostname.split(".");
				if (hostnameParts.length > 2) {
					setTitle(hostnameParts[hostnameParts.length - 2]);
				} else {
					setTitle(hostname);
				}
			}
		}

		if (_tab?.type === "terminal") {
			// Use current directory if available, otherwise fall back to initial path
			const currentPath = (_tab as any).currentDir || _tab.path;
			const folderName = currentPath
				? currentPath === "/"
					? "root"
					: currentPath.split("/").pop() || "root"
				: "term";
			setTitle(`term: ${folderName}`);
		}

		if (_tab?.type === "file") {
			const _node = getNode(_tab?.path);
			setTitle(getSlateForNode(_node)?.name || _node?.name || "untitled");
		}

		if (_tab?.type === "agent") {
			setTitle(_tab.title || "AI Assistant");
		}
	});

	const [icon, setIcon] = createSignal("");

	createEffect(() => {
		setIcon(getIconForTab(tab()));
	});

	// Function to fetch and set favicon
	const fetchFavicon = (_tab: WebTabType) => {
		const defaultIcon = getIconForTab(_tab);

		// Set default icon first
		setIcon(defaultIcon);

		// Then try to fetch the actual favicon
		electrobun.rpc?.request
			.getFaviconForUrl({ url: _tab.url })
			.then((favicon: string) => {
				console.log("getFaviconForUrl returned:", favicon);
				// Only use the favicon if it's a valid URL that's different from our default
				if (
					favicon &&
					favicon !== "" &&
					favicon !== defaultIcon &&
					!favicon.includes("bookmark.svg")
				) {
					console.log("Setting favicon to:", favicon);
					setIcon(favicon);
				} else {
					console.log(
						"No valid favicon found, keeping default icon:",
						defaultIcon,
					);
					setIcon(defaultIcon);
				}
			})
			.catch((err) => {
				console.log("Error getting favicon:", err);
				setIcon(defaultIcon);
			});
	};

	// Initial load - fetch favicon for existing web tabs
	createEffect(() => {
		const _tab = tab();
		if (_tab?.type === "web") {
			const currentIcon = icon();
			const defaultIcon = getIconForTab(_tab);

			// If we only have the default icon (globe), fetch the real favicon
			if (currentIcon === defaultIcon || currentIcon === "") {
				console.log("Initial load - fetching favicon for:", _tab.url);
				fetchFavicon(_tab);
			}
		}
	});

	// Watch for URL changes
	createEffect((prevHostname) => {
		const _tab = tab();
		if (_tab?.type === "web") {
			const hostname = new URL(_tab.url).hostname;

			// Skip if this is the first run and we already fetched the icon
			if (!prevHostname && icon()) {
				return hostname;
			}

			if (hostname !== prevHostname && prevHostname) {
				console.log(
					"Favicon update - hostname changed from",
					prevHostname,
					"to",
					hostname,
				);
				fetchFavicon(_tab);
			}

			return hostname;
		}
	});

	// this is likely the cause of a bug or something and shouldn't happen
	if (paneId !== tab()?.paneId) {
		setState(
			produce((_state: AppState) => {
				const tab = getWindow(_state)?.tabs[tabId];
				if (tab) {
					tab.paneId = paneId;
				}
			}),
		);
	}

	const dropIndicatorStyles = () => {
		if (state.dragState) {
			const { targetPaneId, targetTabIndex } = state.dragState;
			const tab = getWindow()?.tabs[tabId];

			if (!tab) {
				return;
			}

			if (tab.paneId === targetPaneId) {
				if (index() === targetTabIndex) {
					return {
						"border-left": "2px solid #fff",
					};
				}
				if (index() + 1 === targetTabIndex) {
					return {
						"border-right": "2px solid #fff",
					};
				}
			}
		}

		return {};
	};

	const previewStyles = () =>
		tab()?.isPreview ? { "font-style": "italic" } : {};

	const isCurrentTab = () => {
		const pane = getPane(state, pathToPane);
		if (pane && pane.type === "pane") {
			return pane.currentTabId === tabId;
		}
		return false;
	};

	const file = () => {
		const _tab = tab();

		const _node = getNode(_tab?.path);
		if (_node?.type === "file") {
			return _node;
		}
	};

	createEffect(() => {
		const _tab = tab();
		const _node = file();
		if (_node?.isDirty && tab()?.isPreview) {
			setState(
				produce((_state: AppState) => {
					const currentTab = getCurrentTab(_state);
					if (currentTab) {
						currentTab.isPreview = false;
					}
				}),
			);
		}
	});

	const onCloseClick = (e: DomEventWithTarget<MouseEvent>) => {
		// NOTE: We don't want to select the tab when closing it
		// if it wasn't already selected/current
		e.stopImmediatePropagation();
		closeTab(tabId);
	};

	const onClick = () => {
		setState(
			produce((_state: AppState) => {
				const pane = getPane(_state, pathToPane);
				if (pane && pane.type === "pane") {
					pane.currentTabId = tabId;

					const currentTab = getCurrentTab(_state);

					if (currentTab?.isPreview) {
						currentTab.isPreview = false;
					}
				}
			}),
		);

		updateSyncedState();
	};

	const isDroppingTabLeftOfThisTab = () => {
		const { targetPaneId, targetTabIndex, type } = state.dragState || {};
		return paneId === targetPaneId && index() === targetTabIndex;
	};

	const [isHovered, setIsHovered] = createSignal(false);
	const [isHoveredOnX, setIsHoveredOnX] = createSignal(false);

	const onContextMenu = (e: DomEventWithTarget<MouseEvent>) => {
		console.info("right click context menu tab");
	};

	const isDraggingStyles = () => {
		return hideWileDragging()
			? {
					// opacity: "0.3",
					// display: "none",
					// width: "10px",
					// overflow: "hidden",
			  }
			: {};
	};

	return (
		<>
			<div
				// ref={tabRef}
				data-isdragging={hideWileDragging()}
				onMouseEnter={() => setIsHovered(true)}
				onMouseLeave={() => setIsHovered(false)}
				draggable={true}
				data-tabId={tabId}
				onDragStart={(e) => {
					setIsDragging(true);

					setState("dragState", {
						type: "tab",
						id: tabId,
						targetTabIndex: index(),
						targetPaneId: paneId,
					});
				}}
				onDragOver={(e) => {
					console.log("onDragOVer Tab");
					// This removes the animation when dragging is finished where the
					// drag preview slowly animates back to the original location
					e.preventDefault();

					if (state.dragState) {
						const { type } = state.dragState;
						// todo (yoav): add a util for determining if a node can be opened in a new tab
						if (
							type === "tab" ||
							canOpenNodeInNewTab(state.dragState.nodePath)
						) {
							const { targetPaneId, targetTabIndex } = state.dragState;

							if (
								targetPaneId &&
								targetPaneId === paneId &&
								targetTabIndex !== index()
							) {
								setState("dragState", "targetTabIndex", index());
							}
						}
					}
				}}
				onDragEnd={(e) => {
					setIsDragging(false);
					setHideWhileDragging(false);
					if (state.dragState?.type === "tab") {
						const { targetPaneId, targetTabIndex, id } = state.dragState;

						if (!targetPaneId) {
							return;
						}

						setState(
							produce((_state: AppState) => {
								const win = getWindow(_state);
								if (!win) {
									return;
								}
								win.currentPaneId = targetPaneId || "";
							}),
						);

						moveTabToPane(id, targetPaneId, targetTabIndex);
						setState("dragState", null);
					}
				}}
				style={{
					background: isDroppingTabLeftOfThisTab()
						? "#105460"
						: isCurrentTab()
						  ? "#1e1e1e"
						  : isHovered()
							  ? "#303030"
							  : "#292929",
					color: isCurrentTab() ? "#e2e2e2" : "#bbb",
					opacity: isCurrentTab() ? 1 : 0.75,
					padding: "6px 20px 6px 14px",
					// "margin-left": isDroppingTabLeftOfThisTab() ? "150px" : "",
					"line-height": "16px",
					"font-size": "15px",
					cursor: "pointer",
					"border-top": isCurrentTab() ? "2px solid blue" : "2px solid grey",
					"box-shadow": isCurrentTab()
						? "0px 0px 5px 0px #000"
						: "inset 0px 3px 6px -3px rgba(0, 0, 0, 0.4)",
					"z-index": isCurrentTab() ? 1 : "",
					position: "relative",
					"user-select": "none",

					...isDraggingStyles(),
					...dropIndicatorStyles(),
					...previewStyles(),
					transition: "opacity 100ms, margin 100ms",
					"white-space": "nowrap",
					"border-radius": "2px",
					"border-left": "1px solid #000",
					"border-right": "1px solid #000",
					display: "flex",
					"align-items": "center",
				}}
				onClick={onClick}
				onContextMenu={onContextMenu}
			>
				<div
					style={{
						width: "20px",
						height: "20px",
						display: "flex",
						"padding-top": "1px",
						"margin-right": "6px",
						"align-items": "center",
					}}
				>
					<img src={icon()} width="20" height="20" />
				</div>
				<span style={{}}>{title()}</span>
				<Show when={file()?.isDirty && !isHovered()}>
					<div
						style={`position: absolute; top: 7px; right: 3px; ;
          font-size: 20px;
          width: 14px;
          height: 14px;
          border-radius: 3px;
          text-align: center;
          font-style: normal;
          line-height: 11px; `}
					>
						•
					</div>
				</Show>
				<Show when={isHovered()}>
					<div
						onMouseEnter={() => setIsHoveredOnX(true)}
						onMouseLeave={() => setIsHoveredOnX(false)}
						style={`position: absolute; top: 7px; right: 3px; background: ${
							isHoveredOnX() ? "#555" : "transparent"
						};
          font-size: 11px;
          width: 14px;
          height: 14px;
          border-radius: 3px;
          text-align: center;
          font-style: normal;
          line-height: 11px; `}
						onClick={onCloseClick}
					>
						x
					</div>
				</Show>
			</div>
		</>
	);
};

const NodeSettings = () => {
	const { type, data } = state.settingsPane;
	if (!type) {
		return null;
	}

	const node = () => {
		const settingsType = state.settingsPane.type;
		if (settingsType === "add-node" || settingsType === "edit-node") {
			return state.settingsPane.data.node;
		}
		return null;
	};

	const previewNode = () => {
		const settingsType = state.settingsPane.type;
		if (settingsType === "add-node" || settingsType === "edit-node") {
			const pNode = state.settingsPane.data.previewNode;
			return pNode;
		}
		return null;
	};

	let projectNameRef: HTMLInputElement | undefined;
	let inputNameRef: HTMLInputElement | undefined;
	let inputUrlRef: HTMLInputElement | undefined;
	let browserProfileNameRef: HTMLInputElement | undefined;
	let gitUrlRef: HTMLInputElement | undefined;

	// Signal to track the current node type instead of DOM element
	const [currentNodeType, setCurrentNodeType] = createSignal<string>("");

	// Git URL validation state
	const [gitUrlValidation, setGitUrlValidation] = createSignal<{
		status: "idle" | "validating" | "valid" | "invalid";
		error?: string;
	}>({ status: "idle" });

	// GitHub repo selector state
	const [useGitHubSelector, setUseGitHubSelector] = createSignal(true); // Default to GitHub
	const [selectedGitHubRepo, setSelectedGitHubRepo] =
		createSignal<GitHubRepository | null>(null);
	const [selectedGitHubBranch, setSelectedGitHubBranch] = createSignal<
		string | null
	>(null);
	const [shouldCreateMainBranch, setShouldCreateMainBranch] =
		createSignal(false);

	// TODO: you can use electron.showOpenDialog to customize the file chooser rather than have an html file input

	// Track the URL being entered and the final URL with protocol
	const [urlInputValue, setUrlInputValue] = createSignal("");
	const finalUrl = createMemo(() => {
		const val = urlInputValue();
		if (!val) return "";
		const hasProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(val);
		return hasProtocol ? val : `https://${val}`;
	});
	const shouldShowProtocolHint = createMemo(() => {
		const val = urlInputValue();
		if (!val) return false;
		const hasProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(val);
		return !hasProtocol;
	});

	const [browserProfileNameInputValue, setBrowserProfileNameInputValue] =
		createSignal("");

	const suggestedBrowserProfileName = createMemo(() => {
		const val = urlInputValue();
		if (!val) return "";

		try {
			const url = new URL(finalUrl());
			const hostname = url.hostname;

			// Remove www. prefix if present
			const cleanHostname = hostname.replace(/^www\./, "");

			// Extract the main domain name (remove .com, .org, etc.)
			const parts = cleanHostname.split(".");
			if (parts.length > 1) {
				// Capitalize first letter of the main domain
				const mainDomain = parts[0];
				return mainDomain.charAt(0).toUpperCase() + mainDomain.slice(1);
			}

			return cleanHostname;
		} catch (e) {
			// If URL parsing fails, try to extract something useful from the raw input
			const cleanVal = val.replace(/^https?:\/\//, "").replace(/^www\./, "");
			const firstPart = cleanVal.split(".")[0].split("/")[0];
			return firstPart.charAt(0).toUpperCase() + firstPart.slice(1);
		}
	});

	const finalBrowserProfileName = createMemo(() => {
		const userInput = browserProfileNameInputValue().trim();
		return userInput || suggestedBrowserProfileName();
	});

	const shouldShowBrowserProfileNameHint = createMemo(() => {
		return (
			browserProfileNameInputValue().trim() === "" &&
			suggestedBrowserProfileName() !== ""
		);
	});

	// Track if we've already set the initial dropdown value to prevent fighting with user changes
	let hasInitializedDropdown = false;
	let lastSettingsPaneId = "";

	createEffect(() => {
		const _previewNode = previewNode();

		if (!_previewNode) {
			return;
		}

		// Reset dropdown initialization flag when a new settings panel opens
		const currentSettingsPaneId = `${state.settingsPane.type}-${_previewNode.path}`;
		if (currentSettingsPaneId !== lastSettingsPaneId) {
			hasInitializedDropdown = false;
			lastSettingsPaneId = currentSettingsPaneId;
		}

		if (inputNameRef) {
			inputNameRef.value = _previewNode.name;
		}

		// Use selectedNodeType from context menu if available, otherwise infer from node
		const settingsData = state.settingsPane.data;
		const selectedNodeType =
			"selectedNodeType" in settingsData
				? settingsData.selectedNodeType
				: undefined;

		// Only initialize on initial load, not on subsequent effect runs
		if (!hasInitializedDropdown) {
			hasInitializedDropdown = true;

			let nodeType: string;
			if (selectedNodeType) {
				nodeType = selectedNodeType;
			} else if (
				"slate" in _previewNode &&
				_previewNode.slate?.type === "project"
			) {
				nodeType = "project";
			} else if (
				"slate" in _previewNode &&
				_previewNode.slate?.type === "web"
			) {
				nodeType = "web";
			} else if (
				"slate" in _previewNode &&
				_previewNode.slate?.type === "agent"
			) {
				nodeType = "agent";
			} else if (
				"slate" in _previewNode &&
				_previewNode.slate?.type === "repo"
			) {
				nodeType = "repo";
			} else if (
				"slate" in _previewNode &&
				_previewNode.slate?.type === "devlink"
			) {
				nodeType = "devlink";
			} else {
				nodeType = _previewNode.type;
			}

			setCurrentNodeType(nodeType);
			initializeNewNodeType(nodeType);
		}

		// For existing project roots (no slate), populate project name from DB
		if (_previewNode.type === "dir" && projectNameRef) {
			const project = getProjectByRootPath(_previewNode.path);
			if (project) {
				projectNameRef.value = project.name;
			}
		}

		if (
			_previewNode.type !== "dir" ||
			!("slate" in _previewNode) ||
			!_previewNode.slate
		) {
			return;
		}

		const previewSlate = _previewNode.slate as SlateType;

		if (inputUrlRef && "url" in previewSlate) {
			// Show the full URL including protocol
			const displayUrl = previewSlate.url;
			inputUrlRef.value = displayUrl;
			setUrlInputValue(displayUrl);
		}

		if (browserProfileNameRef && "name" in previewSlate) {
			browserProfileNameRef.value = previewSlate.name;
			setBrowserProfileNameInputValue(previewSlate.name);
		} else if (browserProfileNameRef) {
			// If no name is set, initialize with empty string
			setBrowserProfileNameInputValue(browserProfileNameRef.value || "");
		}

		// For new projects being added with a slate, use the slate name
		if (projectNameRef && "name" in previewSlate && previewSlate.type === "project") {
			projectNameRef.value = previewSlate.name;
		}

		// Initialize git inputs for repo slate
		if (previewSlate.type === "repo" && "config" in previewSlate) {
			if (gitUrlRef && previewSlate.config?.gitUrl) {
				gitUrlRef.value = previewSlate.config.gitUrl;
			}
		}
	});

	createEffect((prevPath) => {
		const _previewNode = previewNode();

		// todo (yoav): move this to stores
		setState(
			produce((_state: AppState) => {
				if (
					state.settingsPane.type !== "add-node" &&
					state.settingsPane.type !== "edit-node"
				) {
					return;
				}

				const __previewNode = state.settingsPane.data.previewNode;
				if (
					__previewNode &&
					__previewNode.type === "dir" &&
					"slate" in __previewNode &&
					__previewNode?.slate?.type === "project" &&
					__previewNode?.path !== prevPath
				) {
					const slateConfigPath = join(__previewNode.path, ".bunny.json");
					const slateConfigFromDisk = state.slateCache[slateConfigPath];

					// If the slateConfig from disk is another type like browser profile then don't load it
					// I guess if user continues they'll overwrite it with a new project folder
					// but we can enforce whatever behaviour we want here later
					if (slateConfigFromDisk?.type === "project") {
						__previewNode.slate = slateConfigFromDisk;
					}
				}
			}),
		);

		return _previewNode?.path;
	});

	const isOkToChooseExisitingPath = () =>
		isProjectNode() &&
		state.settingsPane.type === "add-node";

	const isProjectConflict = () => {
		const _previewNode = previewNode();

		if (!_previewNode) {
			throw new Error("previewNode is null");
		}

		if (isProjectNode()) {
			const nodePath = node()?.path;
			const previewNodePath = _previewNode?.path;
			// When editing an existing project, it's not a conflict with itself
			if (
				state.settingsPane.type === "edit-node" &&
				nodePath === previewNodePath
			) {
				return false;
			}

			// Only check for exact duplicate projects (same path)
			// Nested projects are allowed
			const newPath = _previewNode.path;

			const existingDuplicateProject = Object.values(state.projects).find(
				(project) => project.path && newPath === project.path
			);

			if (existingDuplicateProject) {
				return true;
			}
		}

		return false;
	};

	const onSubmit = (e: SubmitEvent) => {
		e.preventDefault();

		(async () => {
			const _node = node();
			const _previewNode = previewNode();

			if (!_node || !_previewNode) {
				return;
			}
			// If it's a web browser profile, ensure the URL has a protocol before saving
			const slateType = getSlateForNode(_previewNode)?.type;

			if (
				slateType === "web" &&
				_previewNode.type === "dir" &&
				"slate" in _previewNode
			) {
				const currentUrl = getSlateForNode(_previewNode)?.url;
				if (currentUrl && !/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(currentUrl)) {
					// Use setPreviewNodeSlateUrl to properly update the reactive state
					setPreviewNodeSlateUrl(`https://${currentUrl}`);
				}

				// Use the final browser profile name (user input or suggested name)
				const nameToUse = finalBrowserProfileName();
				if (nameToUse) {
					setPreviewNodeSlateName(nameToUse);
				}
			}
			// the only time it's ok to choose an existing path is when you're adding a new project
			// because that folder won't already exist in Bunny Dash filetree etc.

			if (!isOkToChooseExisitingPath() && isFileNameConflict()) {
				inputNameRef?.focus();
				inputNameRef?.select();
				return;
			}

			const settingsType = state.settingsPane.type;

			if (
				getSlateForNode(_previewNode)?.type === "project" &&
				settingsType === "add-node" &&
				isProjectConflict()
			) {
				return;
			}

			if (settingsType === "add-node" || _node.path !== _previewNode?.path) {
				// if the node path existed before, rename it
				if (settingsType === "edit-node" && _node) {
					const result = await electrobun.rpc?.request.rename({
						oldPath: _node.path,
						newPath: _previewNode.path,
					});
					if (!result?.success) {
						console.error("Failed to rename node");
					}
				} else if (
					!(await electrobun.rpc?.request.exists({ path: _previewNode.path }))
				) {
					// otherwise create the file or folder
					if (_previewNode.type === "dir") {
						await electrobun.rpc?.request.mkdir({ path: _previewNode.path });
					} else if (_previewNode.type === "file") {
						// save your file here
						const result = electrobun.rpc?.request.writeFile({
							path: _previewNode.path,
							value: "",
						});

						// if (!result?.success) {
						//   // todo: handle failed write
						//   return;
						// }
					}
				}
			}

			// Write .bunny.json for directory slates (web, agent, etc.) but NOT for projects
			// Projects are stored in GoldfishDB and detected via isProjectRoot()
			if (_previewNode.type === "dir" && slateType && slateType !== "project") {
				writeSlateConfigFile(_previewNode.path, getSlateForNode(_previewNode));
			}

			if (isProjectNode()) {
				const absolutePath = _previewNode.path;

				if (settingsType === "edit-node") {
					// For existing projects, get the project by its root path and use the input value
					const project = getProjectByRootPath(_node.path);
					if (project) {
						// Get project name from the input field (which may have been edited)
						const projectName = projectNameRef?.value || project.name;
						electrobun.rpc?.send.editProject({
							projectId: project.id,
							projectName,
							path: absolutePath,
						});
					}
				} else {
					// For new projects, get name from the preview node's slate
					const projectName = getSlateForNode(_previewNode)?.name;
					electrobun.rpc?.request.addProject({
						projectName,
						path: absolutePath,
					});
				}
			} else if (getSlateForNode(_previewNode)?.type === "repo") {
				const repoSlate = getSlateForNode(_previewNode) as any;
				const gitUrl = repoSlate?.config?.gitUrl;

				if (!gitUrl) {
					console.error("Git URL is required for repo clone");
					return;
				}

				// Create the folder first so it appears immediately in file tree
				await electrobun.rpc?.request.mkdir({ path: _previewNode.path });

				// Close settings immediately and expand parent folder
				setNodeExpanded(parentNodePath(_previewNode), true);
				setState("settingsPane", { type: "", data: {} });

				// Start polling for the repo folder immediately
				let pollAttempts = 0;
				const maxAttempts = 20; // Stop after 10 seconds (20 * 500ms)

				const expandWhenReady = () => {
					pollAttempts++;
					// Check if the node exists in the file tree
					const node = getNode(_previewNode.path);
					if (node) {
						console.log("Found repo node, expanding:", _previewNode.path);
						setNodeExpanded(_previewNode.path, true);

						// Also check for the .git folder and open it in a new tab
						const gitFolderPath = join(_previewNode.path, ".git");
						console.log("Looking for git folder at:", gitFolderPath);

						// Start checking for .git folder immediately
						let gitPollAttempts = 0;
						const maxGitAttempts = 20; // Wait up to 10 seconds for .git folder

						const openGitSlateWhenReady = () => {
							gitPollAttempts++;
							const gitNode = getNode(gitFolderPath);
							console.log(
								`Git folder poll attempt ${gitPollAttempts}, found:`,
								gitNode ? "yes" : "no",
							);

							if (gitNode) {
								console.log("Opening git slate for:", gitFolderPath);
								openNewTabForNode(gitFolderPath);
							} else if (gitPollAttempts < maxGitAttempts) {
								setTimeout(openGitSlateWhenReady, 500);
							} else {
								console.log("Timeout waiting for .git folder");
							}
						};

						// Start polling for .git folder immediately, no initial delay
						openGitSlateWhenReady();
					} else if (pollAttempts < maxAttempts) {
						// Node not ready yet, try again in 500ms
						setTimeout(expandWhenReady, 500);
					} else {
						console.log(
							"Timeout waiting for cloned repo to appear in file tree",
						);
					}
				};

				// Start polling immediately, no initial delay
				expandWhenReady();

				// Clone the repository in the background (don't await)
				electrobun.rpc?.request
					.gitClone({
						repoPath: _previewNode.path,
						gitUrl,
						createMainBranch: shouldCreateMainBranch(),
					})
					.then(() => {
						console.log("Repository cloned successfully");
					})
					.catch((error) => {
						console.error("Failed to clone repository:", error);
						// Clean up the empty folder if clone failed
						electrobun.rpc?.request.safeDeleteFileOrFolder({
							absolutePath: _previewNode.path,
						});
						// TODO: Could show a notification to user about failed clone
					});

				// Early return to avoid duplicate setNodeExpanded and setState calls below
				return;
			}

			setNodeExpanded(parentNodePath(_previewNode), true);

			setState("settingsPane", { type: "", data: {} });
		})();
	};

	const onCloseClick = (e: DomEventWithTarget<MouseEvent>) => {
		e.preventDefault();
		e.stopImmediatePropagation();
		setState("settingsPane", { type: "", data: {} });
	};

	const onNameChange = () => {
		if (!inputNameRef) {
			return;
		}

		if (inputNameRef.value === "." || inputNameRef.value === "..") {
			// causes wacky behaviour with the path and changes the
			// location of the previewnode
			return;
		}

		const name = makeFileNameSafe(inputNameRef.value);
		const _previewNode = previewNode();

		if (!_previewNode) {
			return;
		}
		// we use the original node because we can assume that it had a name and can split
		// based on / to get the parent. when editing previewNode.path may have a blank name
		// and so splitting on / would return the grandparent
		const absolutePath = join(parentNodePath(_previewNode), name);

		if (inputNameRef.value !== name) {
			inputNameRef.value = name;
		}

		setState(
			produce((_state: AppState) => {
				if (
					_state.settingsPane.type !== "add-node" &&
					_state.settingsPane.type !== "edit-node"
				) {
					return;
				}

				const __previewNode = _state.settingsPane.data.previewNode;
				if (__previewNode) {
					__previewNode.name = name;
					__previewNode.path = absolutePath;

					// Also update slate name for slate-based nodes (like repos, projects, etc.)
					if (
						__previewNode.type === "dir" &&
						"slate" in __previewNode &&
						__previewNode.slate &&
						"name" in __previewNode.slate
					) {
						__previewNode.slate.name = name;
					}
				}
			}),
		);
	};

	// todo (yoav): move this to producers

	const onProjectNameInputChange = () => {
		if (projectNameRef) {
			setPreviewNodeSlateName(projectNameRef.value);
		}
	};

	const onBrowserProfileNameInputChange = () => {
		if (browserProfileNameRef) {
			setBrowserProfileNameInputValue(browserProfileNameRef.value);
			// Use the final browser profile name (user input or suggested name as fallback)
			const finalName =
				browserProfileNameRef.value.trim() || suggestedBrowserProfileName();
			setPreviewNodeSlateName(finalName);
		}
	};

	// Debounced validation for git URL
	let gitUrlValidationTimeout: number | undefined;

	const validateGitUrl = async (url: string) => {
		if (!url.trim()) {
			setGitUrlValidation({ status: "idle" });
			return;
		}

		setGitUrlValidation({ status: "validating" });

		try {
			const result = await electrobun.rpc?.request.gitValidateUrl({
				gitUrl: url,
			});
			if (result?.valid) {
				setGitUrlValidation({ status: "valid" });
			} else {
				setGitUrlValidation({
					status: "invalid",
					error: result?.error || "Invalid repository URL",
				});
			}
		} catch (error) {
			setGitUrlValidation({
				status: "invalid",
				error: "Failed to validate URL",
			});
		}
	};

	const onGitUrlInputChange = () => {
		if (gitUrlRef) {
			const url = gitUrlRef.value;
			setPreviewNodeSlateConfig({ gitUrl: url });

			// Clear previous timeout
			if (gitUrlValidationTimeout) {
				clearTimeout(gitUrlValidationTimeout);
			}

			// Debounce validation (wait 500ms after user stops typing)
			gitUrlValidationTimeout = window.setTimeout(() => {
				validateGitUrl(url);
			}, 500);
		}
	};

	// Handler for GitHub repository selection
	const onGitHubRepoSelect = (
		repo: GitHubRepository,
		branch?: string,
		isEmptyRepo?: boolean,
	) => {
		setSelectedGitHubRepo(repo);
		setSelectedGitHubBranch(branch || null); // Don't auto-set branch, let user click
		setShouldCreateMainBranch(isEmptyRepo || false);

		// Update the folder name input with the repo name
		if (inputNameRef) {
			inputNameRef.value = repo.name;
			// Trigger the onInput event to update validation and preview node name
			onNameChange();
		}

		// Update the git URL in the preview node config only when branch is explicitly selected
		if (branch) {
			const gitUrl = repo.clone_url;
			setPreviewNodeSlateConfig({
				gitUrl,
				branch: branch,
			});

			// Update the text input to show the selected URL
			if (gitUrlRef) {
				gitUrlRef.value = gitUrl;
			}

			// Validate the URL immediately since we know it's valid
			setGitUrlValidation({ status: "valid" });
		}
	};

	let lastType = "";
	const initializeNewNodeType = async (type: string) => {
		if (lastType === type) {
			return;
		}
		lastType = type;
		const _previewNode = untrack(previewNode);

		if (!_previewNode || state.settingsPane.type !== "add-node") {
			return;
		}
		const nodeType = type === "file" ? "file" : "dir";

		// setup
		if (type === "project") {
			// For project type, get a unique name but keep the existing slate intact
			const newName = await electrobun.rpc?.request.getUniqueNewName({
				parentPath: parentNodePath(_previewNode),
				baseName: "new-project",
			});

			// Update the preview node with the unique name
			setState(
				produce((_state: AppState) => {
					if (
						_state.settingsPane.type === "add-node" &&
						"previewNode" in _state.settingsPane.data
					) {
						const previewNode = _state.settingsPane.data.previewNode;
						previewNode.name = newName;
						previewNode.path = join(parentNodePath(previewNode), newName);

						// Also update the slate name to match
						if ("slate" in previewNode && previewNode.slate) {
							previewNode.slate.name = newName;
						}
					}
				}),
			);

			return;
		}
		if (type === "web") {
			const newName = await electrobun.rpc?.request.getUniqueNewName({
				parentPath: parentNodePath(_previewNode),
				baseName: "new-browser-profile",
			});
			setPreviewNode({
				type: "dir",
				name: newName,
				path: join(parentNodePath(_previewNode), newName),
				isExpanded: true,
				children: [],
				slate: {
					v: 1,
					name: "",
					icon: defaultWebFaviconUrl(),
					type: "web",
					url: "https://duckduckgo.com",
					config: {
						renderer: "system" as const,
					},
				},
			});
			// setState("settingsPane", "data", "previewNode", );
		} else if (type === "agent") {
			const newName = await electrobun.rpc?.request.getUniqueNewName({
				parentPath: parentNodePath(_previewNode),
				baseName: "new-agent",
			});
			setPreviewNode({
				type: "dir",
				name: newName,
				path: join(parentNodePath(_previewNode), newName),
				isExpanded: true,
				children: [],
				slate: {
					v: 1,
					name: "AI Assistant",
					icon: "views://assets/file-icons/agent.svg",
					type: "agent",
					config: {
						model: state.appSettings.llama.model,
						temperature: 0.7,
						conversationHistory: [],
					},
				},
			});
		} else if (type === "repo") {
			const newName = await electrobun.rpc?.request.getUniqueNewName({
				parentPath: parentNodePath(_previewNode),
				baseName: "new-repo",
			});

			// Reset validation state when creating new repo
			setGitUrlValidation({ status: "idle" });

			setPreviewNode({
				type: "dir",
				name: newName,
				path: join(parentNodePath(_previewNode), newName),
				isExpanded: true,
				children: [],
				slate: {
					v: 1,
					name: newName,
					icon: "🔀",
					type: "repo",
					config: {
						gitUrl: "",
					},
				},
			});
		} else if (type === "devlink") {
			const defaultFolder = "devlink";
			setPreviewNode({
				type: "dir",
				name: defaultFolder,
				path: join(parentNodePath(_previewNode), defaultFolder),
				isExpanded: true,
				slate: {
					type: "devlink",
				},
				// children: [],
				previewChildren: [
					{
						type: "dir",
						name: "components",
						isExpanded: true,
						path: "", //path.join(data.node.path, defaultFolder, "components"),
						// children: [],
						previewChildren: [],
					},
				],
			});
		} else {
			if (nodeType === "file") {
				const nodeName = await electrobun.rpc?.request.getUniqueNewName({
					parentPath: parentNodePath(_previewNode),
					baseName: "new-file",
				});
				setPreviewNode({
					type: "file",
					name: nodeName,
					path: join(parentNodePath(_previewNode), nodeName),
					persistedContent: "",
					isDirty: false,
					model: null,
					editors: {},
				});
			} else if (nodeType === "dir") {
				const nodeName = await electrobun.rpc?.request.getUniqueNewName({
					parentPath: parentNodePath(_previewNode),
					baseName: "new-folder",
				});
				setPreviewNode({
					type: "dir",
					name: nodeName,
					path: join(parentNodePath(_previewNode), nodeName),
					previewChildren: [],
					isExpanded: false,
				});
			}
		}
	};

	const onPathChooserClick = async () => {
		const startingFolder =
			previewNode()?.path || state.paths?.BUNNY_PROJECTS_FOLDER || "";
		const filesAndFolders = await electrobun.rpc?.request.openFileDialog({
			startingFolder,
			allowedFileTypes: "",
			canChooseFiles: false,
			canChooseDirectory: true,
			allowsMultipleSelection: false,
		});

		const chosenPath = filesAndFolders?.[0];

		setState(
			produce((_state: AppState) => {
				if (
					chosenPath &&
					(_state.settingsPane.type === "add-node" ||
						_state.settingsPane.type === "edit-node")
				) {
					_state.settingsPane.data.previewNode.path = chosenPath;
					_state.settingsPane.data.previewNode.name =
						chosenPath.split("/").pop() || "";
				}
			}),
		);
	};

	// todo (yoav): consider using a webview and page-favicon-updated
	// to get the favicon instead of doing it manually with fetch
	let hostnameForFavicon = "";
	const onUrlInputChange = (
		e: DomEventWithTarget<InputEvent, HTMLInputElement>,
	) => {
		const inputValue = e.currentTarget.value;
		setUrlInputValue(inputValue);

		// If no value, just clear the URL
		if (!inputValue) {
			setPreviewNodeSlateUrl("");
			return;
		}

		// Save the raw input value without adding protocol
		setPreviewNodeSlateUrl(inputValue);
		const name = makeFileNameSafe(inputValue);

		setState(
			produce((_state: AppState) => {
				if (
					_state.settingsPane.type !== "add-node" &&
					_state.settingsPane.type !== "edit-node"
				) {
					return;
				}

				const __previewNode = _state.settingsPane.data.previewNode;
				if (__previewNode) {
					__previewNode.name = name;
					const absolutePath = join(parentNodePath(__previewNode), name);
					__previewNode.path = absolutePath;
				}
			}),
		);

		// For favicon fetching, we need a valid URL with protocol
		const hasProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(inputValue);
		const urlForFavicon = hasProtocol ? inputValue : `https://${inputValue}`;

		let hostname = "";
		try {
			hostname = new URL(urlForFavicon).origin;
		} catch (e) {
			// If still invalid, user might be typing and it's not complete yet
		}

		if (hostname) {
			if (hostnameForFavicon !== hostname) {
				hostnameForFavicon = hostname;
				electrobun.rpc?.request
					.getFaviconForUrl({ url: urlForFavicon })
					.then((icon) => {
						if (icon) {
							setPreviewNodeSlateIcon(icon);
						}
					});
			}
		}
	};

	const namePlaceholder = () => {
		if (getSlateForNode(previewNode())?.type === "desktop") {
			return "Desktop App Name";
		}
		if (getSlateForNode(previewNode())) {
			return "Name";
		}
		return `New ${previewNode()?.type === "file" ? "File" : "Folder"} Name`;
	};

	onMount(() => {
		inputNameRef?.focus();
	});

	const isEditingNode = () => state.settingsPane.type === "edit-node";
	const isAddingNode = () => state.settingsPane.type === "add-node";
	const isProjectNode = () => {
		const settingsPaneData = state.settingsPane.data;
		if ("previewNode" in settingsPaneData) {
			// Check if this is a project root either by slate type (for new projects being added)
			// or by checking if the node's path matches a project path (for existing projects)
			const slateType = getSlateForNode(settingsPaneData.previewNode)?.type;
			if (slateType === "project") return true;
			return isProjectRoot(settingsPaneData.previewNode);
		}
	};

	const settingsTitle = () => {
		if (isProjectNode()) {
			return isEditingNode() ? "Edit Project" : "Add Project";
		}
		return isEditingNode() ? "Edit Node" : "Add Node";
	};

	const friendlyTypeName = {
		file: "File",
		dir: "Folder",
		web: "Browser Profile",
		agent: "AI Agent",
		repo: "Git Repository",
		devlink: "DevLink",
		// desktop: "Desktop App",
	};

	const getNodeTypeName = () =>
		previewNode()?.type === "file" ? "File" : "Folder";

	const getCurrentNodeTypeDisplayName = () => {
		const nodeType = currentNodeType();
		if (nodeType && nodeType in friendlyTypeName) {
			return friendlyTypeName[nodeType as keyof typeof friendlyTypeName];
		}
		return nodeType === "file" ? "File" : "Folder";
	};

	const [nodeTypeName, setNodeTypeName] = createSignal(getNodeTypeName());

	createEffect(() => {
		console.log("createEffect::::", getNodeTypeName());
		setNodeTypeName(getNodeTypeName());
	});

	const onClickRemoveCompletely = () => {
		const _node = node();
		if (_node?.path) {
			if (
				"node" in state.settingsPane.data &&
				state.settingsPane.data.node.path === _node?.path
			) {
				setState("settingsPane", { type: "", data: {} });
			}

			// Check if this specific node is a project root
			const projectForRoot = getProjectByRootPath(_node.path);

			if (projectForRoot) {
				// For project root nodes, use the project-specific deletion
				electrobun.rpc?.send.fullyDeleteProjectFromDiskAndBunnyDash({
					projectId: projectForRoot.id,
				});
			} else {
				// For regular nodes or nested nodes within projects, use node deletion
				electrobun.rpc?.send.fullyDeleteNodeFromDisk({
					nodePath: _node.path,
				});
			}
		}
	};

	const onClickRemoveProjectFromBunnyDashOnly = () => {
		const _node = node();
		if (_node) {
			// Use getProjectByRootPath to find the project whose root IS this node
			// (not just a project that contains this node)
			const project = getProjectByRootPath(_node.path);
			if (project) {
				electrobun.rpc?.send.removeProjectFromBunnyDashOnly({
					projectId: project.id,
				});
			}
			setState("settingsPane", { type: "", data: {} });
		}
	};

	const onClickRemoveBrowserProfileSlateFromBunnyDashOnly = async () => {
		const _node = node();
		if (getSlateForNode(_node)?.type === "web" && _node?.path) {
			const slateConfigPath = join(_node.path, ".bunny.json");
			if (await electrobun.rpc?.request.exists({ path: slateConfigPath })) {
				await electrobun.rpc?.request.safeDeleteFileOrFolder({
					absolutePath: slateConfigPath,
				});
			}
		}

		setState("settingsPane", { type: "", data: {} });
	};

	const [isFileNameConflict, setFileNameConflict] = createSignal(false);

	createEffect(async () => {
		const _node = node();
		const _previewNode = previewNode();
		if (
			state.settingsPane.type === "edit-node" &&
			_previewNode?.path === _node?.path
		) {
			return false;
		}

		if (!_previewNode?.path) {
			return false;
		}

		const _exists = Boolean(
			await electrobun.rpc?.request.exists({ path: _previewNode?.path }),
		);

		setFileNameConflict(_exists);
	});

	const getBasePathText = () => {
		const _previewNode = previewNode();
		if (_previewNode) {
			return `${parentNodePath(_previewNode)}/`;
		}
		return "error";
	};

	const onClickEditPreloadScript = async () => {
		const nodePath = node()?.path;
		if (!nodePath) {
			return;
		}

		const preloadScriptPath = join(nodePath, ".preload.js");

		const result = await electrobun.rpc?.request.touchFile({
			path: preloadScriptPath,
		});

		if (!result?.success) {
			// todo: handle error
			console.error("error creating preload script", result?.error);
		}

		setState("settingsPane", { type: "", data: {} });
		openNewTabForNode(preloadScriptPath);
	};

	const [folderInputLabel, setFolderInputLabel] = createSignal("");

	createEffect(async () => {
		if (isProjectNode()) {
			const _projectPath = previewNode()?.path;
			if (!_projectPath) {
				return;
			}

			setFolderInputLabel(
				(await electrobun.rpc?.request.exists({ path: _projectPath }))
					? "Select folder"
					: "Create folder",
			);
		}
		const nodeType = previewNode()?.type;
		const isFile = nodeType === "file";
		setFolderInputLabel(
			state.settingsPane.type === "add-node"
				? isFile ? "Create file" : "Create folder"
				: isFile ? "Rename file" : "Rename folder",
		);
	});

	return (
		<div
			style={{
				background: "#404040",
				width: "100%",
				height: "100%",
				display: "flex",
				"flex-direction": "column",
				color: "#d9d9d9",
			}}
		>
			<form style="" onSubmit={onSubmit}>
				<div
					class="settings-header"
					style="display: flex; flex-direction: row; height: 45px; font-size: 20px; line-height: 45px; padding: 0 10px; align-items: center;"
				>
					<h1 style="font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;font-weight: 400;margin: 0 0px 0 0;overflow-x: hidden;text-overflow: ellipsis;white-space: nowrap;padding: 3px 11px;font-size: 20px;line-height: 1.34;">
						{settingsTitle()}
					</h1>
					<div
						class="actions"
						style="display: flex;-webkit-box-flex: 1;-ms-flex-positive: 1;flex-grow: 1;-ms-flex-negative: 0;flex-shrink: 0;-webkit-box-pack: end;-ms-flex-pack: end;justify-content: flex-end;-webkit-box-align: center;-ms-flex-align: center;align-items: center;"
					/>
					<div style="flex-grow: 0;margin-left: 8px;display: -webkit-box;display: -ms-flexbox;display: flex;-webkit-box-flex: 1;-ms-flex-positive: 1;flex-grow: 1;-ms-flex-negative: 0;flex-shrink: 0;-webkit-box-pack: end;-ms-flex-pack: end;justify-content: flex-end;-webkit-box-align: center;-ms-flex-align: center;align-items: center;">
						<button
							type="button"
							onClick={onCloseClick}
							style="border-color: rgb(54, 54, 54);outline: 0px;cursor: default;-webkit-user-select: none;padding: 0px 12px;font-family: inherit;font-size: 12px;position: relative;display: flex;align-items: center;justify-content: center;height: 32px;border-radius: 2px;color: rgb(235, 235, 235);background: rgb(94, 94, 94);border-width: 1px;border-style: solid;box-sizing: border-box;align-self: center;"
						>
							Close
						</button>
						<button
							type="submit"
							style="border-color: rgb(54, 54, 54);outline: 0px;cursor: default;-webkit-user-select: none;margin-left: 8px;padding: 0px 12px;font-family: inherit;font-size: 12px;position: relative;display: flex;align-items: center;justify-content: center;height: 32px;border-radius: 2px 0px 0px 2px;color: rgb(255, 255, 255);background: rgb(0, 115, 230);border-width: 1px 0px 1px 1px;border-style: solid;box-sizing: border-box;align-self: center;"
						>
							Save
						</button>
					</div>
				</div>
				<div style="display: flex;flex-direction: column;flex-grow: 1;overflow: auto overlay; border-top: 1px solid #212121">
					<div style="flex-grow: 1;align-self: stretch;    box-sizing: border-box;">
						<div>
							<div class="formbody">
								<div style="margin-top: 0px;background-color: transparent;border-left: 0px solid rgb(33, 33, 33);border-right: 0px solid rgb(33, 33, 33);border-radius: 0px;border-bottom: 1px solid rgb(33, 33, 33);">
									<SettingsPaneFormSection
										label={() => `${nodeTypeName()} Settings`}
									>
										<Show when={!isProjectNode() && !isEditingNode()}>
											<div class="field" style="margin-top: 0px;">
												<div style="display: flex;flex-direction: column;">
													<div
														class="field-head"
														style="display: flex;-webkit-box-align: end;-ms-flex-align: end;align-items: flex-end;-ms-flex-wrap: wrap;flex-wrap: wrap;margin-bottom: 8px;"
													>
														<div style="box-sizing: border-box;color: rgb(217, 217, 217);cursor: default;display: block;font-family: Inter, -apple-system, 'system-ui', 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;font-size: 12px;height: 16px;line-height: 16px;max-width: 100%;overflow-x: hidden;overflow-y: hidden;pointer-events: auto;text-overflow: ellipsis;text-size-adjust: 100%;user-select: text;white-space: nowrap;">
															Type
														</div>
													</div>

													<div style="background: #2b2b2b;border: 1px solid #212121;color: #efefef;padding: 8px;border-radius: 4px;font-size: 14px;font-weight: 600;">
														{getCurrentNodeTypeDisplayName()}
													</div>
												</div>
											</div>
										</Show>
										<Show
											when={
												state.settingsPane.type === "add-node" &&
												isProjectNode()
											}
										>
											<SettingsPaneField label="Select or Create a project folder">
												{/* <div style=" border-color: rgb(54, 54, 54);outline: 0px;user-select: none;padding: 0px 12px;font-family: inherit;font-size: 12px;position: relative;display: flex;align-items: center;justify-content: center;height: 32px;border-radius: 2px;color: rgb(235, 235, 235);background: rgb(94, 94, 94);border-width: 1px;border-style: solid;box-sizing: border-box;">
                          <div style="font-size: 12px; position: absolute;">
                            Open an existing folder
                          </div> */}
												<button
													type="button"
													name="path"
													// webkitdirectory
													// directory
													// multiple
													onClick={onPathChooserClick}
													style="cursor: pointer; border-color: rgb(54, 54, 54);outline: 0px;-webkit-user-select: none;padding: 0px 12px;font-family: inherit;font-size: 12px;position: relative;display: flex;align-items: center;justify-content: center;height: 32px;border-radius: 2px;color: rgb(235, 235, 235);background: rgb(94, 94, 94);border-width: 1px;border-style: solid;box-sizing: border-box;"
												>
													Select an existing folder
												</button>
												{/* </div> */}
											</SettingsPaneField>
										</Show>
										<SettingsPaneField label={folderInputLabel}>
											<input
												type="text"
												ref={inputNameRef}
												name="name"
												onInput={onNameChange}
												placeholder={namePlaceholder()}
												style="background: #2b2b2b;border-radius: #2b2b2b;border: 1px solid #212121;color: #d9d9d9;outline: none;cursor: text;display: block;font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;font-size: 12px;padding-top: 8px;padding-right: 9px;padding-bottom: 8px;padding-left: 9px;line-height: 14px;"
											/>

											<div style="margin-top: 8px; box-shadow: 0 0 0 1px #363636; cursor: text;background: #4d4d4d;padding: 4px;">
												<div style="overflow: hidden;text-overflow: ellipsis;display: flex;align-items: center;">
													<span style="margin-left:4px;color: #ababab; font-size:14px; line-height: 16px">
														{getBasePathText()}
														<strong style="color: rgb(217, 217, 217)">
															{previewNode()?.name}
														</strong>
													</span>
												</div>
											</div>
											{/* <Show when={isFileNameConflict()}> */}
											<Switch>
												<Match when={isProjectConflict()}>
													<div style="color: #dd4444; font-size: 12px; margin-top: 4px;">
														This folder is already added as a project
													</div>
												</Match>
												<Match
													when={
														isOkToChooseExisitingPath() && isFileNameConflict()
													}
												>
													<div style="color: #44dd44; font-size: 12px; margin-top: 4px;">
														Existing project folder will be added
													</div>
												</Match>
												<Match
													when={
														!isOkToChooseExisitingPath() && isFileNameConflict()
													}
												>
													<div style="color: #dd4444; font-size: 12px; margin-top: 4px;">
														A file or folder with that name already exists
													</div>
												</Match>
											</Switch>
											{/* </Show> */}
										</SettingsPaneField>
										<Show when={state.settingsPane.type === "edit-node"}>
											<SettingsPaneField label="">
												{" "}
												<button
													type="button"
													onClick={onClickRemoveCompletely}
													style="cursor: pointer;background: #dd4444;color: white;font-weight: bold;border: none;padding: 10px;margin: 4px 0 8px;"
												>
													Delete from disk
												</button>
												<span style="font-size: 11px;color: #999;background: #333;padding: 10px;">
													Will instantly delete all files and folders in{" "}
													{node()?.path}. They will go to the recycle bin.
												</span>
											</SettingsPaneField>
										</Show>
									</SettingsPaneFormSection>

									<Show
										when={isProjectNode()}
									>
										<SettingsPaneFormSection label={"Project Settings"}>
											<SettingsPaneField label="Project Name">
												<input
													type="text"
													ref={projectNameRef}
													name="browserprofilename"
													onInput={onProjectNameInputChange}
													placeholder="Name this browser profile"
													style="background: #2b2b2b;border-radius: #2b2b2b;border: 1px solid #212121;color: #d9d9d9;outline: none;cursor: text;display: block;font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;font-size: 12px;padding-top: 8px;padding-right: 9px;padding-bottom: 8px;padding-left: 9px;line-height: 14px;"
												/>
											</SettingsPaneField>
											<Show when={state.settingsPane.type === "edit-node"}>
												<SettingsPaneField label="">
													<button
														type="button"
														onClick={onClickRemoveProjectFromBunnyDashOnly}
														style="cursor: pointer;background: #dd4444;color: white;font-weight: bold;border: none;padding: 10px;margin: 4px 0 8px;"
													>
														Remove Project
													</button>
													<span style="font-size: 11px;color: #999;background: #333;padding: 10px;">
														Will remove the project from Bunny Dash, but files at{" "}
														{node()?.path} will remain. You can re-add the
														project later if you'd like.
													</span>
												</SettingsPaneField>
											</Show>
										</SettingsPaneFormSection>
									</Show>
									<Show when={getSlateForNode(previewNode())?.type === "web"}>
										<SettingsPaneFormSection
											label={`${friendlyTypeName.web} Settings`}
										>
											<SettingsPaneField label="Url">
												<div style="position: relative;">
													<input
														type="text"
														ref={inputUrlRef}
														name="url"
														onInput={onUrlInputChange}
														placeholder="example.com or https://example.com"
														style="background: #2b2b2b;border-radius: #2b2b2b;border: 1px solid #212121;color: #d9d9d9;outline: none;cursor: text;display: block;font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;font-size: 12px;padding-top: 8px;padding-right: 9px;padding-bottom: 8px;padding-left: 9px;line-height: 14px;width: 100%;box-sizing: border-box;"
													/>
													<Show when={shouldShowProtocolHint()}>
														<div style="font-size: 11px; color: #888; margin-top: 4px;">
															Will save as:{" "}
															<span style="color: #aaa;">{finalUrl()}</span>
														</div>
													</Show>
												</div>
											</SettingsPaneField>
											<SettingsPaneField label="Browser Profile Name">
												<div>
													<input
														type="text"
														ref={browserProfileNameRef}
														name="browserprofilename"
														onInput={onBrowserProfileNameInputChange}
														placeholder="Name this browser profile"
														style="background: #2b2b2b;border-radius: #2b2b2b;border: 1px solid #212121;color: #d9d9d9;outline: none;cursor: text;display: block;font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;font-size: 12px;padding-top: 8px;padding-right: 9px;padding-bottom: 8px;padding-left: 9px;line-height: 14px;width: 100%;box-sizing: border-box;"
													/>
													<Show when={shouldShowBrowserProfileNameHint()}>
														<div style="font-size: 11px; color: #888; margin-top: 4px;">
															Will save as:{" "}
															<span style="color: #aaa;">
																{finalBrowserProfileName()}
															</span>
														</div>
													</Show>
												</div>
											</SettingsPaneField>
											<SettingsPaneField label="Browser Engine">
												<select
													name="renderer"
													value={createMemo(() => {
														const slate = getSlateForNode(previewNode());
														if (
															slate?.type === "web" &&
															slate.config &&
															"renderer" in slate.config
														) {
															return slate.config.renderer || "system";
														}
														return "system";
													})()}
													onInput={(e: any) => {
														const renderer = e.currentTarget.value as
															| "cef"
															| "system";
														setPreviewNodeSlateConfig({ renderer });
													}}
													style="background: #2b2b2b;border-radius: #2b2b2b;border: 1px solid #212121;color: #d9d9d9;outline: none;cursor: pointer;display: block;font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;font-size: 12px;padding-top: 8px;padding-right: 9px;padding-bottom: 8px;padding-left: 9px;line-height: 14px;width: 100%;box-sizing: border-box;"
												>
													<option value="cef">Chromium (CEF)</option>
													<option value="system">WebKit (System)</option>
												</select>
												<div style="font-size: 11px; color: #888; margin-top: 4px; background: #333; padding: 8px; border-radius: 4px;">
													<div style="margin-bottom: 4px;">
														<strong>Chromium (CEF):</strong> Full Chrome browser
														engine. Best compatibility with modern web apps.
													</div>
													<div>
														<strong>WebKit (System):</strong> Native macOS
														browser engine. Lighter weight, better for simple
														sites.
													</div>
												</div>
											</SettingsPaneField>
											<Show when={state.settingsPane.type === "edit-node"}>
												<SettingsPaneField label="Preload Script">
													<button
														type="button"
														onClick={onClickEditPreloadScript}
														style="cursor: pointer;background: #222;color: white;font-weight: bold;border: none;padding: 10px;margin: 4px 0 8px;"
													>
														Edit
													</button>
													<span style="font-size: 11px;color: #999;background: #333;padding: 10px;">
														Insert javascript and css into the page when loading
														this profile
													</span>
												</SettingsPaneField>
											</Show>
											<Show when={state.settingsPane.type === "edit-node"}>
												<SettingsPaneField label="">
													<button
														type="button"
														onClick={
															onClickRemoveBrowserProfileSlateFromBunnyDashOnly
														}
														style="cursor: pointer;background: #dd4444;color: white;font-weight: bold;border: none;padding: 10px;margin: 4px 0 8px;"
													>
														Remove Profile
													</button>
													<span style="font-size: 11px;color: #999;background: #333;padding: 10px;">
														Will remove the profile from Bunny Dash, converting
														this to a regular folder.
													</span>
												</SettingsPaneField>
											</Show>
										</SettingsPaneFormSection>
									</Show>

									<Show when={getSlateForNode(previewNode())?.type === "agent"}>
										<SettingsPaneFormSection
											label={`${friendlyTypeName.agent} Settings`}
										>
											<SettingsPaneField label="Agent Name">
												<input
													type="text"
													ref={browserProfileNameRef}
													name="agentname"
													onInput={onBrowserProfileNameInputChange}
													placeholder="Give your AI agent a name"
													style="background: #2b2b2b;border-radius: #2b2b2b;border: 1px solid #212121;color: #d9d9d9;outline: none;cursor: text;display: block;font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;font-size: 12px;padding-top: 8px;padding-right: 9px;padding-bottom: 8px;padding-left: 9px;line-height: 14px;"
												/>
											</SettingsPaneField>
										</SettingsPaneFormSection>
									</Show>

									<Show when={getSlateForNode(previewNode())?.type === "repo"}>
										<SettingsPaneFormSection
											label={`${friendlyTypeName.repo} Settings`}
										>
											<SettingsPaneField label="Repository Source">
												<div style="display: flex; gap: 8px; margin-bottom: 12px;">
													<button
														type="button"
														onClick={() => setUseGitHubSelector(true)}
														style={{
															background: useGitHubSelector()
																? "#0969da"
																: "#2b2b2b",
															color: useGitHubSelector() ? "white" : "#d9d9d9",
															border: "1px solid #555",
															padding: "6px 12px",
															"border-radius": "4px",
															cursor: "pointer",
															"font-size": "11px",
															flex: "1",
														}}
													>
														Browse GitHub
													</button>
													<button
														type="button"
														onClick={() => setUseGitHubSelector(false)}
														style={{
															background: !useGitHubSelector()
																? "#0969da"
																: "#2b2b2b",
															color: !useGitHubSelector() ? "white" : "#d9d9d9",
															border: "1px solid #555",
															padding: "6px 12px",
															"border-radius": "4px",
															cursor: "pointer",
															"font-size": "11px",
															flex: "1",
														}}
													>
														Manual URL
													</button>
												</div>
											</SettingsPaneField>

											<Show when={!useGitHubSelector()}>
												<SettingsPaneField label="Git Repository URL">
													<style>{`
                            @keyframes spin {
                              from { transform: rotate(0deg); }
                              to { transform: rotate(360deg); }
                            }
                          `}</style>
													<div style="position: relative;">
														<input
															type="text"
															ref={gitUrlRef}
															name="gitUrl"
															onInput={onGitUrlInputChange}
															placeholder="https://github.com/user/repo.git"
															style="background: #2b2b2b;border-radius: #2b2b2b;border: 1px solid #212121;color: #d9d9d9;outline: none;cursor: text;display: block;font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu, Cantarell, 'Helvetica Neue', Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;font-size: 12px;padding-top: 8px;padding-right: 32px;padding-bottom: 8px;padding-left: 9px;line-height: 14px;width: 100%;box-sizing: border-box;"
														/>
														<div
															style={{
																position: "absolute",
																right: "8px",
																top: "50%",
																transform: "translateY(-50%)",
																display:
																	gitUrlValidation().status === "idle"
																		? "none"
																		: "block",
																"font-size": "14px",
															}}
														>
															{gitUrlValidation().status === "validating" && (
																<div
																	style={{
																		color: "#858585",
																		animation: "spin 1s linear infinite",
																		display: "inline-block",
																	}}
																>
																	⟳
																</div>
															)}
															{gitUrlValidation().status === "valid" && (
																<div style={{ color: "#44987e" }}>✓</div>
															)}
															{gitUrlValidation().status === "invalid" && (
																<div
																	style={{ color: "#e06c75", cursor: "help" }}
																	title={gitUrlValidation().error}
																>
																	✗
																</div>
															)}
														</div>
													</div>
												</SettingsPaneField>
											</Show>

											<Show
												when={
													useGitHubSelector() && githubService.isConnected()
												}
											>
												<SettingsPaneField label="GitHub Repository">
													<div style="border: 1px solid #555; border-radius: 4px; min-height: 500px; max-height: 1000px; height: 600px;">
														<GitHubRepoSelector
															onSelectRepository={onGitHubRepoSelect}
															selectedRepo={selectedGitHubRepo()}
															selectedBranch={selectedGitHubBranch()}
														/>
													</div>
												</SettingsPaneField>
											</Show>

											<Show
												when={
													useGitHubSelector() && !githubService.isConnected()
												}
											>
												<SettingsPaneField label="">
													<div style="background: #2b2b2b; padding: 12px; border-radius: 4px; border: 1px solid #555;">
														<div style="font-size: 11px; color: #ffa500; margin-bottom: 8px;">
															GitHub Not Connected
														</div>
														<div style="font-size: 10px; color: #999; margin-bottom: 8px;">
															Connect your GitHub account in workspace settings
															to browse your repositories.
														</div>
														<button
															type="button"
															onClick={() => {
																setState("settingsPane", {
																	type: "github-settings",
																	data: {},
																});
															}}
															style="background: #0969da; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 10px;"
														>
															Connect GitHub
														</button>
													</div>
												</SettingsPaneField>
											</Show>
										</SettingsPaneFormSection>
									</Show>

									</div>
							</div>
						</div>
					</div>
				</div>
			</form>
		</div>
	);
};

const Sidebar = () => {
	const [isDraggingResize, setIsDraggingResize] = createSignal(false);
	const [isHoveredResize, setIsHoveredResize] = createSignal(false);

	const width = () => {
		const currentWindow = getWindow();
		if (!currentWindow?.ui.showSidebar) return "0px";
		const sidebarWidth = currentWindow.ui.sidebarWidth || 250;
		return `${sidebarWidth}px`;
	};
	console.log("rendering Sidebar");

	let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;

	const onResizeMouseDown = (e: DomEventWithTarget<MouseEvent>) => {
		if (e.button !== 0) return;
		e.preventDefault();
		setIsDraggingResize(true);
		setState("isResizingPane", true);

		const handleMouseMove = (e: MouseEvent) => {
			const currentWindow = getWindow();
			if (!currentWindow) return;

			const currentWidth = currentWindow.ui.sidebarWidth || 250;
			const newWidth = Math.max(250, Math.min(600, currentWidth + e.movementX));

			setState(
				"workspace",
				"windows",
				(w) => w.id === currentWindow.id,
				"ui",
				"sidebarWidth",
				newWidth,
			);
		};

		const handleMouseUp = () => {
			setIsDraggingResize(false);
			setState("isResizingPane", false);

			// Persist the width to database when done resizing
			const currentWindow = getWindow();
			if (currentWindow) {
				updateSyncedState();
			}

			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
		};

		document.addEventListener("mousemove", handleMouseMove);
		document.addEventListener("mouseup", handleMouseUp);
	};

	const onFindAllChange = (e: InputEvent) => {
		const value = e.target?.value;

		// Clear results and cancel ongoing searches immediately
		if (value !== state.findAllInFolder.query) {
			setState(
				produce((_state: AppState) => {
					_state.findAllInFolder = { query: value, results: {} };
				}),
			);

			// Cancel any ongoing find all searches
			electrobun.rpc?.request.cancelFindAll();
		}

		// Clear any pending debounced search
		if (searchDebounceTimer) {
			clearTimeout(searchDebounceTimer);
		}

		// Toggle file tree filter based on whether there's a query
		if (state.ui.filterFileTreeByFindAll !== Boolean(value)) {
			setState("ui", "filterFileTreeByFindAll", Boolean(value));
		}

		// Debounce the actual search - wait for user to stop typing
		if (value) {
			searchDebounceTimer = setTimeout(() => {
				electrobun.rpc?.request
					.findAllInWorkspace({ query: value })
					.catch((error) => {
						console.error("Find all search error:", error);
					});
			}, 200); // Wait 300ms after last keystroke
		}
	};

	const toggleShowFilter = () => {
		setState(
			"ui",
			"filterFileTreeByFindAll",
			!state.ui.filterFileTreeByFindAll,
		);
	};

	return (
		<div
			style={{
				width: width(),
				height: "100%",
				flex: "none",
				position: "relative",
				display: "flex",
				"flex-direction": "row",
				transition: "none",
			}}
		>
			<div
				style={{
					flex: "1",
					height: "100%",
					"background-color": "#e7e2df",
					overflow: "scroll",
					"box-sizing": "border-box",
					"white-space": "nowrap",
				}}
				onDragOver={(e) => {
					e.preventDefault();
					if (state.dragState?.type === "node") {
						setState("dragState", "targetPaneId", null);
					}
				}}
			>
				<div
					style={{
						display: "flex",
						"flex-direction": "row",
						"justify-content": "space-between",
						padding: "6px 6px 0px",
					}}
				>
					<input
						ref={(r) => (globalFindAllInput = r)}
						style={`
            background: #3c3c3c;
            border: 1px solid #464647;
            border-radius: 3px;
            padding: 6px 30px 6px 8px;
            color: #cccccc;
            flex-grow: 1;
            margin-right: -26px;
            font-size: 13px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            box-shadow: none;
            outline: none;
          `}
						placeholder="Find All"
						onInput={onFindAllChange}
					/>
					<div
						style={{
							width: "15px",
							background: state.ui.filterFileTreeByFindAll
								? "rgba(0, 0, 0, .4)"
								: "transparent",
							"border-radius": "8px",
							padding: "2px 6px",
							color: "#999",
							cursor: "pointer",
							"user-select": "none",
						}}
						onClick={toggleShowFilter}
					>
						<svg
							style={{
								// filter: state.ui.filterFileTreeByFindAll ? "invert()" : "",
								filter: "invert()",
							}}
							xmlns="http://www.w3.org/2000/svg"
							x="0px"
							y="0px"
							width="100%"
							height="100%"
							viewBox="0 0 50 50"
						>
							<path d="M 21 3 C 11.601563 3 4 10.601563 4 20 C 4 29.398438 11.601563 37 21 37 C 24.355469 37 27.460938 36.015625 30.09375 34.34375 L 42.375 46.625 L 46.625 42.375 L 34.5 30.28125 C 36.679688 27.421875 38 23.878906 38 20 C 38 10.601563 30.398438 3 21 3 Z M 21 7 C 28.199219 7 34 12.800781 34 20 C 34 27.199219 28.199219 33 21 33 C 13.800781 33 8 27.199219 8 20 C 8 12.800781 13.800781 7 21 7 Z" />
						</svg>
					</div>
				</div>
				<div style={{}}>
					{/* <CategoryRow label="Favs" /> */}
					{state.ui.filterFileTreeByFindAll ? (
						<FindAllResultsTree />
					) : (
						<>
							<TemplateNodes />
							<OpenFilesTree />
							<WorkspaceLensesTree />
							<ProjectsTree />
						</>
					)}
				</div>
			</div>

			{/* Resize handle */}
			<Show when={getWindow()?.ui.showSidebar}>
				<div
					style={{
						cursor: "ew-resize",
						width: "4px",
						height: "100%",
						transition: "background 150ms",
						background: isHoveredResize() ? "#105460" : "#333",
						position: "absolute",
						right: "0",
						top: "0",
						"z-index": 20,
						"-webkit-user-select": "none",
					}}
					onMouseDown={onResizeMouseDown}
					onMouseEnter={() => setIsHoveredResize(true)}
					onMouseLeave={() => setIsHoveredResize(false)}
				/>
			</Show>
		</div>
	);
};

// let debounceLiClick: null | NodeJS.Timeout = null;

// todo (yoav): simplify this component

const appElement = document.querySelector("#app");

// todo (yoav): we should only render the app when we have the state
// and have a state type that doesn't have all the nulls and such to avoid
// a ton of type checking issues
if (appElement) {
	render(App, appElement);
} else {
	console.error("no #app element to render into");
}
