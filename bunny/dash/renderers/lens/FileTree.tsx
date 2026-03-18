import {
	getProjectForNode,
	getSlateForNode,
	isDescendantPath,
	isProjectRoot,
	getProjectByRootPath,
} from "./files";

import {
	type Accessor,
	type JSX,
	For,
	Match,
	Show,
	Switch,
	createEffect,
	createMemo,
	createSignal,
	createResource,
} from "solid-js";
import { produce, unwrap } from "solid-js/store";
import type {
	DomEventWithTarget,
	PostMessageShowContextMenu,
	CachedFileType,
	PreviewFileTreeType,
	PreviewFileNodeType,
} from "../../shared/types/types";

import { getNode } from "./FileWatcher";

import {
	type AppState,
	type BunnyDashWorkspaceTreeType,
	editNodeSettings,
	focusTabWithId,
	getCurrentTab,
	getPaneWithId,
	getWindow,
	openFileAt,
	openNewTabForNode,
	openNewTerminalTab,
	setNodeExpanded,
	setState,
	state,
	syncWorkspaceNow,
	updateSyncedState,
	removeOpenFile,
} from "./store";

import { electrobun } from "./init";
import { parentNodePath } from "../utils/fileUtils";

import { join, basename, dirname } from "../utils/pathUtils";

// Type for plugin file decorations
interface FileDecoration {
	badge?: string;
	badgeColor?: string;
	tooltip?: string;
	faded?: boolean;
	color?: string;
}

// Cache for file decorations to avoid repeated RPC calls
const fileDecorationCache: Map<
	string,
	{ decoration: FileDecoration | null; timestamp: number }
> = new Map();
const DECORATION_CACHE_TTL = 5000; // 5 seconds

async function getFileDecoration(
	filePath: string,
): Promise<FileDecoration | null> {
	const cached = fileDecorationCache.get(filePath);
	if (cached && Date.now() - cached.timestamp < DECORATION_CACHE_TTL) {
		return cached.decoration;
	}

	try {
		const decoration = await electrobun.rpc?.request.pluginGetFileDecoration({
			filePath,
		});
		fileDecorationCache.set(filePath, {
			decoration: decoration || null,
			timestamp: Date.now(),
		});
		return decoration || null;
	} catch (err) {
		console.warn("Failed to fetch file decoration:", err);
		return null;
	}
}

const makeSafeSerializer = () => {
	const seen = new WeakSet();

	return (key, value) => {
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			return value;
		}

		if (
			typeof value === "function" ||
			typeof value === "symbol" ||
			value === undefined ||
			value instanceof Map ||
			value instanceof Set ||
			value instanceof WeakMap ||
			value instanceof WeakSet ||
			value instanceof Date ||
			value instanceof RegExp
		) {
			console.error("serializer skipping special type", key, value);
			return;
		}

		if (typeof value === "object" && value !== null) {
			if (seen.has(value)) {
				console.error("serializer skipping cyclical reference", key, value);
				return;
			}
			seen.add(value);
		}

		return value;
	};
};

async function refreshDashStateFromWorker() {
	const nextState = await electrobun.rpc?.request.getInitialState();
	if (!nextState) {
		return;
	}

	const payload = nextState as {
		windowId?: string;
		workspace?: unknown;
		bunnyDash?: unknown;
		projects?: Array<{ id: string }>;
		tokens?: unknown[];
		appSettings?: Record<string, unknown>;
	};

	const projectsById = Array.isArray(payload.projects)
		? payload.projects.reduce((acc: Record<string, any>, project: any) => {
				if (project?.id) {
					acc[project.id] = project;
				}
				return acc;
			}, {})
		: {};

	if (payload.windowId) {
		setState("windowId", payload.windowId);
	}
	if (payload.workspace) {
		setState("workspace", payload.workspace as any);
	}
	if (payload.bunnyDash) {
		setState("bunnyDash", payload.bunnyDash as any);
	}
	setState("projects", projectsById);
	setState("tokens", Array.isArray(payload.tokens) ? payload.tokens : []);
	if (payload.appSettings) {
		setState("appSettings", { ...state.appSettings, ...payload.appSettings });
	}
}

function dispatchWindowTransition(name: "begin" | "end", label?: string) {
	if (name === "begin") {
		window.dispatchEvent(
			new CustomEvent("bunnyDashBeginWindowTransition", {
				detail: { label },
			}),
		);
		return;
	}

	window.dispatchEvent(new CustomEvent("bunnyDashEndWindowTransition"));
}

function sleep(ms: number) {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function runInWindowTransition<T>(label: string, work: () => Promise<T>) {
	dispatchWindowTransition("begin", label);
	await sleep(1000);
	try {
		return await work();
	} finally {
		dispatchWindowTransition("end");
	}
}

export const createContextMenuAction = (action: string, data: any) => {
	return {
		action,
		data: {
			...data,
			windowId: state.windowId,
			workspaceId: state.workspace.id,
		},
	};
};

/**
 * Note: The UL/LI structure of the file tree is important for the folder lines
 * The NodeName is responsible for rendering a single node
 */

// files and folders without an slate gui that we don't want to render
const filesToFilter = {
	simple: /\.DS_Store|node_modules|package-lock\.json|\.bunny\.json|.+\.d\.ts/,
	showall: null,
};

const CategoryRow = ({
	label,
	showAddButton = false,
}: {
	label: string;
	showAddButton?: boolean;
}) => {
	const [showHoverControls, setShowHoverControls] = createSignal(false);
	const [isAddButtonHovered, setIsAddButtonHovered] = createSignal(false);
	const [isEmptyWorkspace, setIsEmptyWorkspace] = createSignal(false);

	createEffect(() => {
		const emptyWorkspace = Object.keys(state.projects || {}).length === 0;

		setIsEmptyWorkspace(emptyWorkspace);
		setShowHoverControls(emptyWorkspace);
	});

	return (
		<div
			style={{
				"font-family":
					"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
				color: "#333",
				margin: "8px",
				"font-size": "13px",
				cursor: "default",
				"font-weight": "bold",
				position: "relative",
				padding: "4px",
			}}
			onMouseEnter={() => showAddButton && setShowHoverControls(true)}
			onMouseLeave={() => {
				if (!isEmptyWorkspace()) {
					setShowHoverControls(false);
				}
			}}
		>
			{label}
			<Show when={showAddButton}>
				<div
					style={{
						position: "absolute",
						right: "6px",
						top: "6px",
						width: "18px",
						height: "18px",
						background: isAddButtonHovered()
							? "rgba(59, 130, 246, 0.15)"
							: "rgba(0, 0, 0, 0.08)",
						border: isAddButtonHovered()
							? "1px solid rgba(59, 130, 246, 0.4)"
							: "1px solid rgba(0, 0, 0, 0.15)",
						"text-align": "center",
						"line-height": "17px",
						opacity: showHoverControls() ? 1 : 0,
						cursor: "pointer",
						"border-radius": "3px",
						transition: "all 0.15s ease",
						color: isAddButtonHovered()
							? "rgba(59, 130, 246, 0.9)"
							: "rgba(0, 0, 0, 0.5)",
						"font-size": "14px",
						"font-weight": "500",
					}}
					onMouseEnter={() => setIsAddButtonHovered(true)}
					onMouseLeave={() => setIsAddButtonHovered(false)}
					onClick={() => {
						electrobun.rpc?.request
							.newPreviewNode({ candidateName: "new-project" })
							.then((newNode) => {
								// Add project slate to the preview node so it's recognized as a project
								const projectPreviewNode = {
									...newNode,
									slate: {
										v: 1,
										name: newNode.name,
										type: "project" as const,
										url: "",
										icon: "views://assets/file-icons/folder.svg",
										config: {},
									},
								};

								console.log(
									"Creating project preview node with slate:",
									projectPreviewNode,
								);

								setState(
									"settingsPane",
									state.settingsPane.type === "add-node"
										? {
												type: "",
												data: {},
											}
										: {
												type: "add-node",
												data: {
													node: projectPreviewNode,
													previewNode: projectPreviewNode,
												},
											},
								);
							});
					}}
				>
					+
				</div>
			</Show>
		</div>
	);
};

// Template node definitions for quick access items
const TEMPLATE_NODES = [
	// {
	//   id: "browser-chromium",
	//   name: "Chromium",
	//   path: "__BUNNY_TEMPLATE__/browser-chromium",
	//   icon: "views://assets/file-icons/chrome-logo.svg",
	// },
	{
		id: "browser-webkit",
		name: "Web Browser",
		path: "__BUNNY_TEMPLATE__/browser-webkit",
		icon: "views://assets/file-icons/webkit-logo.svg",
	},
	{
		id: "terminal",
		name: "Terminal",
		path: "__BUNNY_TEMPLATE__/terminal",
		icon: "views://assets/file-icons/terminal.svg",
	},
	{
		id: "agent",
		name: "AI Chat",
		path: "__BUNNY_TEMPLATE__/agent",
		icon: "views://assets/file-icons/agent.svg",
	},
] as const;

const TemplateNodeItem = ({
	template,
}: {
	template: (typeof TEMPLATE_NODES)[number];
}) => {
	const [isHovered, setIsHovered] = createSignal(false);

	const handleDragStart = (e: DragEvent) => {
		e.stopPropagation();
		// Set dragState compatible with existing pane drop logic
		setState("dragState", {
			type: "node",
			nodePath: template.path,
			isTemplate: true,
			templateId: template.id,
		});
	};

	const handleDragEnd = async (e: DragEvent) => {
		e.stopPropagation();

		if (!state.dragState) {
			return;
		}

		const { targetPaneId, targetTabIndex, targetFolderPath, templateId } =
			state.dragState;

		// Handle drop onto pane (opens ephemeral tab)
		if (targetPaneId) {
			setState(
				produce((_state: AppState) => {
					const win = getWindow(_state);
					if (win) {
						win.currentPaneId = targetPaneId;
					}
				}),
			);

			if (template.id === "terminal") {
				const homeDir = state.paths?.BUNNY_HOME_FOLDER || undefined;
				openNewTerminalTab(homeDir, {
					targetPaneId,
					targetTabIndex,
				});
			} else {
				openNewTabForNode(template.path, false, {
					targetPaneId,
					targetTabIndex,
				});
			}

			setState("dragState", null);
			return;
		}

		// Handle drop onto folder (creates persistent node)
		if (targetFolderPath && templateId) {
			setNodeExpanded(targetFolderPath, true);

			if (templateId === "terminal") {
				// Get the target node to determine if it's a file or folder
				const targetNode = getNode(targetFolderPath);
				let terminalCwd = targetFolderPath;

				// If dropped on a file, use its parent directory
				if (targetNode?.type === "file") {
					const pathParts = targetFolderPath.split("/");
					pathParts.pop();
					terminalCwd = pathParts.join("/");
				}

				// Open terminal at the target location in the active pane
				openNewTerminalTab(terminalCwd);
			} else if (templateId === "browser") {
				const baseName = "Browser";
				const uniqueName = await electrobun.rpc?.request.getUniqueNewName({
					parentPath: targetFolderPath,
					baseName,
				});
				const browserProfilePath = join(targetFolderPath, uniqueName);

				await electrobun.rpc?.request.mkdir({ path: browserProfilePath });

				const slateConfig = {
					v: 1,
					name: uniqueName,
					type: "web",
					url: "https://blackboard.sh",
					icon: "views://assets/file-icons/bookmark.svg",
					config: {
						renderer: "system" as const,
					},
				};

				const slateConfigPath = join(browserProfilePath, ".bunny.json");
				await electrobun.rpc?.request.writeFile({
					path: slateConfigPath,
					value: JSON.stringify(slateConfig, null, 2),
				});

				openNewTabForNode(browserProfilePath, false, { focusNewTab: true });
			} else if (templateId === "agent") {
				const baseName = "AI Chat";
				const uniqueName = await electrobun.rpc?.request.getUniqueNewName({
					parentPath: targetFolderPath,
					baseName,
				});
				const agentPath = join(targetFolderPath, uniqueName);

				await electrobun.rpc?.request.mkdir({ path: agentPath });

				const slateConfig = {
					v: 1,
					name: uniqueName,
					type: "agent",
					icon: "views://assets/file-icons/agent.svg",
					config: {},
				};

				const slateConfigPath = join(agentPath, ".bunny.json");
				await electrobun.rpc?.request.writeFile({
					path: slateConfigPath,
					value: JSON.stringify(slateConfig, null, 2),
				});

				openNewTabForNode(agentPath, false, { focusNewTab: true });
			}
		}

		setState("dragState", null);
	};

	const openTemplate = () => {
		// Handle different template types appropriately
		if (template.id === "terminal") {
			// Use home directory if available, otherwise fall back to current directory
			const homeDir = state.paths?.BUNNY_HOME_FOLDER || undefined;
			openNewTerminalTab(homeDir);
		} else if (
			template.id === "browser-chromium" ||
			template.id === "browser-webkit"
		) {
			// For browser templates, create a unique internal path for each tab instance
			// This prevents multiple tabs from sharing the same node/webview instance
			const uniqueId = Math.random().toString(36).substring(2, 11);
			const uniquePath = `${template.path}/${uniqueId}`;
			openNewTabForNode(uniquePath, false, { focusNewTab: true });
		} else {
			// For agent and other templates, use the standard tab opener
			openNewTabForNode(template.path, false, { focusNewTab: true });
		}
	};

	const handleDoubleClick = (e: MouseEvent) => {
		e.stopPropagation();
		openTemplate();
	};

	const handleClick = (e: MouseEvent) => {
		// Single click also opens ephemeral tab
		if (e.detail === 1) {
			openTemplate();
		}
	};

	return (
		<div
			draggable={true}
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
			onClick={handleClick}
			onDblClick={handleDoubleClick}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
			style={{
				display: "flex",
				"align-items": "center",
				padding: "4px 8px 4px 16px",
				cursor: "pointer",
				background: isHovered() ? "rgba(0, 0, 0, 0.1)" : "transparent",
				"user-select": "none",
				margin: "2px 8px",
				"border-radius": "4px",
			}}
		>
			<img
				src={template.icon}
				style={{
					width: "16px",
					height: "16px",
					"margin-right": "8px",
				}}
			/>
			<span
				style={{
					"font-size": "13px",
					color: "#333",
					"font-family":
						"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
				}}
			>
				{template.name}
			</span>
		</div>
	);
};

export const TemplateNodes = () => {
	return (
		<>
			<CategoryRow label="Quick Access" />
			<div style={{ "margin-bottom": "12px" }}>
				<For each={TEMPLATE_NODES}>
					{(template) => <TemplateNodeItem template={template} />}
				</For>
			</div>
		</>
	);
};

export const ProjectsTree = () => {
	const projectsAsArray = () => {
		return Object.values(state.projects);
	};

	return (
		<>
			<CategoryRow label="Projects" showAddButton={true} />
			<For each={projectsAsArray()}>
				{(project) => {
					const node = () => getNode(project.path);

					return (
						<Show when={node()}>
							<TreeUL>
								<FileTree node={node()!} />
							</TreeUL>
						</Show>
					);
				}}
			</For>
		</>
	);
};

const WorkspaceTreeRow = (props: {
	node: CachedFileType | PreviewFileTreeType;
	label: string;
	icon: string;
	isCurrent?: boolean;
	expanded?: Accessor<boolean>;
	hasChildren?: boolean;
	onToggle?: () => void;
	onActivate?: (event: MouseEvent) => void;
	onContextMenu?: (event: MouseEvent) => void;
	subtitle?: string;
	actions?: Array<{
		label: string;
		onClick: () => void;
	}>;
}) => {
	const [isHovered, setIsHovered] = createSignal(false);
	const [isExpandHovered, setIsExpandHovered] = createSignal(false);

	const focusedRowBackground = () => {
		if (props.isCurrent) {
			return "rgba(0, 150, 255, 0.3)";
		}
		if (isHovered()) {
			return "rgba(0, 0, 0, 0.1)";
		}
		return "transparent";
	};

	return (
		<span
			onClick={(event) => {
				event.stopPropagation();
				props.onActivate?.(event);
			}}
			onContextMenu={(event) => {
				event.preventDefault();
				event.stopPropagation();
				props.onContextMenu?.(event);
			}}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => {
				setIsHovered(false);
				setIsExpandHovered(false);
			}}
			style={{
				"-webkit-user-select": "none",
				display: "flex",
				"text-overflow": "ellipsis",
				width: "100%",
				overflow: "hidden",
				cursor: "pointer",
				position: "relative",
			}}
		>
			<span
				style={{
					background: focusedRowBackground(),
					transition: "background-color 0.25s ease-out",
					position: "absolute",
					top: "0px",
					right: "0px",
					height: "23px",
					left: "-100px",
				}}
			/>
			<span
				style={{
					padding: "0px 4px 0 5px",
					width: "8px",
					height: "23px",
					"margin-left": "0px",
					color: "#666",
					background: "transparent",
					display: "flex",
					"align-items": "center",
					opacity: props.hasChildren ? "1" : "0.2",
				}}
			>
				<div
					onMouseEnter={() => setIsExpandHovered(true)}
					onMouseLeave={() => setIsExpandHovered(false)}
					onClick={(event) => {
						event.stopPropagation();
						props.onToggle?.();
					}}
					style={{
						width: "8px",
						rotate: props.expanded?.() ? "0deg" : "-90deg",
						translate: isExpandHovered() ? "2px" : "0px",
						"transform-origin": "center",
						transition: "translate 0.1s ease-in-out, rotate 0.2s ease-in-out",
						display: "flex",
						"align-items": "center",
						visibility: props.hasChildren ? "visible" : "hidden",
					}}
				>
					<Show when={props.hasChildren}>
						<img
							width={10}
							height={10}
							src="views://assets/file-icons/folder-arrow-down.svg"
							style={{
								rotate: props.expanded?.() ? "0deg" : "-90deg",
							}}
						/>
					</Show>
				</div>
			</span>
			<span
				style={{
					padding: "0",
					overflow: "show",
					width: "100%",
					"text-overflow": "ellipsis",
					position: "relative",
					display: "flex",
					"align-items": "center",
				}}
			>
				<div
					style={{
						width: "16px",
						height: "23px",
						display: "flex",
						"margin-right": "5px",
						"align-items": "center",
					}}
				>
					<img src={props.icon} width="16" height="16" />
				</div>
				<span
					style={{
						display: "flex",
						cursor: "pointer",
						width: "100%",
						overflow: "hidden",
					}}
				>
					<span
						style={{
							color: "#333",
							background: "transparent",
							"font-weight": props.isCurrent ? "600" : "400",
							overflow: "hidden",
							"text-overflow": "ellipsis",
							"white-space": "nowrap",
						}}
					>
						{props.label}
					</span>
					<Show when={props.subtitle}>
						<span
							style={{
								"margin-left": "6px",
								color: "#666",
								"font-size": "11px",
								"flex-shrink": 0,
							}}
						>
							{props.subtitle}
						</span>
					</Show>
					<Show when={props.actions?.length && (isHovered() || props.isCurrent)}>
						<span
							style={{
								display: "flex",
								gap: "4px",
								"margin-left": "8px",
								"flex-shrink": 0,
							}}
						>
							<For each={props.actions || []}>
								{(action) => (
									<button
										type="button"
										onMouseDown={(event) => {
											event.preventDefault();
											event.stopPropagation();
										}}
										onClick={(event) => {
											event.preventDefault();
											event.stopPropagation();
											void Promise.resolve(action.onClick()).catch((error) => {
												console.error("Workspace tree action failed:", error);
											});
										}}
										style={{
											border: "1px solid rgba(0, 0, 0, 0.14)",
											background: "rgba(255, 255, 255, 0.85)",
											color: "#333",
											"font-size": "10px",
											"line-height": "14px",
											padding: "0 6px",
											"border-radius": "999px",
											cursor: "pointer",
										}}
									>
										{action.label}
									</button>
								)}
							</For>
						</span>
					</Show>
				</span>
			</span>
		</span>
	);
};

export const WorkspaceLensesTree = () => {
	const [expandedWorkspaceIds, setExpandedWorkspaceIds] = createSignal<Set<string>>(new Set());

	createEffect(() => {
		let changed = false;
		const next = new Set(expandedWorkspaceIds());
		for (const workspace of state.bunnyDash.workspaces) {
			if ((workspace.isCurrent || next.size === 0) && !next.has(workspace.id)) {
				next.add(workspace.id);
				changed = true;
			}
		}
		if (changed) {
			setExpandedWorkspaceIds(next);
		}
	});

	const toggleWorkspace = (workspaceId: string) => {
		setExpandedWorkspaceIds((current) => {
			const next = new Set(current);
			if (next.has(workspaceId)) {
				next.delete(workspaceId);
			} else {
				next.add(workspaceId);
			}
			return next;
		});
	};

	const openLens = async (
		lensId: string,
		workspace: BunnyDashWorkspaceTreeType,
		lens: BunnyDashWorkspaceTreeType["lenses"][number],
	) => {
		const label = `${workspace.name} · ${lens.name}`;
		await runInWindowTransition(label, async () => {
			await syncWorkspaceNow();
			await electrobun.rpc?.request.openLens({ lensId });
			await refreshDashStateFromWorker();
		});
	};

	const openLensInNewWindow = async (lensId: string) => {
		await syncWorkspaceNow();
		await electrobun.rpc?.request.openLensInNewWindow({ lensId });
		await refreshDashStateFromWorker();
	};

	const openWorkspace = async (
		workspaceId: string,
		workspace: BunnyDashWorkspaceTreeType,
	) => {
		await runInWindowTransition(workspace.name, async () => {
			await syncWorkspaceNow();
			await electrobun.rpc?.request.openWorkspace({ workspaceId });
			await refreshDashStateFromWorker();
		});
	};

	const openWorkspaceInNewWindow = async (workspaceId: string) => {
		await syncWorkspaceNow();
		await electrobun.rpc?.request.openWorkspaceInNewWindow({ workspaceId });
		await refreshDashStateFromWorker();
	};

	const openCreateLensSettings = async (workspaceId: string) => {
		const name =
			(await electrobun.rpc?.request.getUniqueLensName({
				workspaceId,
				baseName: "Lens",
			})) || "Lens 1";

		setState("settingsPane", {
			type: "lens-settings",
			data: {
				mode: "create",
				workspaceId,
				name,
				description: "",
			},
		});
	};

	const restoreCurrentLens = async (
		workspace: BunnyDashWorkspaceTreeType,
		lens: BunnyDashWorkspaceTreeType["lenses"][number],
	) => {
		await runInWindowTransition(`${workspace.name} · ${lens.name}`, async () => {
			await electrobun.rpc?.request.openLens({ lensId: lens.id });
			await refreshDashStateFromWorker();
		});
	};

	const overwriteCurrentLens = async () => {
		console.log("[bunny-dash] overwriteCurrentLens click");
		await syncWorkspaceNow();
		console.log("[bunny-dash] overwriteCurrentLens synced");
		await electrobun.rpc?.request.overwriteCurrentLens();
		console.log("[bunny-dash] overwriteCurrentLens resolved");
		await refreshDashStateFromWorker();
	};

	const showWorkspaceContextMenu = async (
		event: MouseEvent,
		workspace: BunnyDashWorkspaceTreeType,
	) => {
		event.preventDefault();
		event.stopPropagation();
		await syncWorkspaceNow();
		await electrobun.rpc?.request.showContextMenu({
			menuItems: [
				{
					label: "New Lens...",
					...createContextMenuAction("workspace_new_lens", {
						workspaceId: workspace.id,
					}),
				},
				{
					type: "separator",
				},
				{
					label: "Open in New Window",
					...createContextMenuAction("workspace_open_in_new_window", {
						workspaceId: workspace.id,
					}),
				},
			],
		});
	};

	const showLensContextMenu = async (
		event: MouseEvent,
		workspace: BunnyDashWorkspaceTreeType,
		lens: BunnyDashWorkspaceTreeType["lenses"][number],
	) => {
		event.preventDefault();
		event.stopPropagation();
		await syncWorkspaceNow();
		await electrobun.rpc?.request.showContextMenu({
			menuItems: [
				{
					label: "Open in New Window",
					...createContextMenuAction("lens_open_in_new_window", {
						workspaceId: workspace.id,
						lensId: lens.id,
					}),
				},
				{
					label: "Rename Lens...",
					...createContextMenuAction("lens_rename", {
						workspaceId: workspace.id,
						lensId: lens.id,
					}),
				},
				{
					label: "Fork",
					...createContextMenuAction("lens_fork", {
						workspaceId: workspace.id,
						lensId: lens.id,
					}),
				},
				{
					type: "separator",
				},
				{
					label: "Delete Lens",
					...createContextMenuAction("lens_delete", {
						workspaceId: workspace.id,
						lensId: lens.id,
					}),
				},
			],
		});
	};

	return (
		<>
			<CategoryRow label="Workspaces" />
			<Show when={state.bunnyDash.workspaces.length > 0}>
				<TreeUL>
					<For each={state.bunnyDash.workspaces}>
						{(workspace: BunnyDashWorkspaceTreeType) => {
							const isExpanded = () => expandedWorkspaceIds().has(workspace.id);
							const workspaceNode = {
								type: "dir" as const,
								name: workspace.name,
								path: `__BUNNY_WORKSPACE__/${workspace.id}`,
								children: [],
							};

							return (
								<TreeLI node={workspaceNode as any}>
									<WorkspaceTreeRow
										node={workspaceNode as any}
										label={workspace.name}
										icon="views://assets/file-icons/new-window.svg"
										subtitle={workspace.currentLensIsActive ? "Current" : ""}
										hasChildren={workspace.canExpand}
										expanded={isExpanded}
										isCurrent={workspace.currentLensIsActive}
										onToggle={() => toggleWorkspace(workspace.id)}
										onActivate={(event) => {
											if (event.metaKey || event.ctrlKey) {
												void openWorkspaceInNewWindow(workspace.id);
												return;
											}
											void openWorkspace(workspace.id, workspace);
										}}
										onContextMenu={(event) => {
											void showWorkspaceContextMenu(event, workspace);
										}}
										actions={
											workspace.id === state.bunnyDash.currentWorkspaceId
												? [
														{
															label: "Save",
															onClick: () => {
																void openCreateLensSettings(workspace.id);
															},
														},
													]
												: []
										}
									/>
									<Show when={isExpanded()}>
										<TreeUL showLeftBar={true}>
											<For each={workspace.lenses}>
												{(lens) => {
													const lensNode = {
														type: "file" as const,
														name: lens.name,
														path: `__BUNNY_LENS__/${lens.id}`,
														persistedContent: "",
														isDirty: false,
														model: null,
														editors: {},
													};

													return (
														<TreeLI node={lensNode as any}>
															<WorkspaceTreeRow
																node={lensNode as any}
																label={lens.name}
																icon="views://assets/file-icons/bookmark.svg"
																isCurrent={lens.isCurrent}
																subtitle={lens.isDirty ? "modified" : ""}
																onActivate={(event) => {
																	if (event.metaKey || event.ctrlKey) {
																		void openLensInNewWindow(lens.id);
																		return;
																	}
																	void openLens(lens.id, workspace, lens);
																}}
																onContextMenu={(event) => {
																	void showLensContextMenu(event, workspace, lens);
																}}
																actions={
																	lens.isCurrent
																		? [
																				{
																					label: "Save",
																					onClick: () => {
																						void overwriteCurrentLens();
																					},
																				},
																				{
																					label: "Restore",
																					onClick: () => {
																						void restoreCurrentLens(workspace, lens);
																					},
																				},
																			]
																		: []
																}
															/>
														</TreeLI>
													);
												}}
											</For>
										</TreeUL>
									</Show>
								</TreeLI>
							);
						}}
					</For>
				</TreeUL>
			</Show>
		</>
	);
};

// Component for displaying files opened outside of projects
const OpenFileItem = ({
	path,
	file,
}: {
	path: string;
	file: { name: string; type: "file" | "dir"; addedAt: number };
}) => {
	const [isHovered, setIsHovered] = createSignal(false);

	const isSelected = () => {
		const currentTab = getCurrentTab(state);
		return currentTab?.path === path;
	};

	const handleClick = async (e: MouseEvent) => {
		e.stopPropagation();
		if (file.type === "file") {
			// For non-project files, we need to ensure the node is cached first
			if (!state.fileCache[path]) {
				const node = await electrobun.rpc?.request.getNode({ path });
				if (node) {
					setState("fileCache", path, node);
				} else {
					console.error("Could not get node for file:", path);
					return;
				}
			}
			openFileAt(path, 1, 1);
		} else {
			openNewTerminalTab(path);
		}
	};

	const handleContextMenu = (e: MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();

		electrobun.rpc?.request.showContextMenu({
			menuItems: [
				{
					label: "Open",
					...createContextMenuAction("open_open_file", { filePath: path }),
				},
				{
					label: "Copy Path to Clipboard",
					...createContextMenuAction("copy_path_to_clipboard", {
						nodePath: path,
					}),
				},
				{ type: "separator" },
				{
					label: "Remove from List",
					...createContextMenuAction("remove_open_file", { filePath: path }),
				},
				{
					label: "Open in Finder",
					...createContextMenuAction("open_node_in_finder", { nodePath: path }),
				},
			],
		});
	};

	const getIcon = () => {
		if (file.type === "dir") {
			return "views://assets/file-icons/folder.svg";
		}
		const ext = file.name.split(".").pop()?.toLowerCase();
		switch (ext) {
			case "ts":
			case "tsx":
				return "views://assets/file-icons/tsx.svg";
			case "js":
				return "views://assets/file-icons/js.svg";
			case "css":
				return "views://assets/file-icons/css.svg";
			case "json":
				return "views://assets/file-icons/json.svg";
			case "md":
				return "views://assets/file-icons/markdown.svg";
			default:
				return "views://assets/file-icons/txt.svg";
		}
	};

	return (
		<div
			onClick={handleClick}
			onContextMenu={handleContextMenu}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
			title={path}
			style={{
				display: "flex",
				"align-items": "center",
				padding: "4px 8px 4px 16px",
				cursor: "pointer",
				background: isSelected()
					? "rgba(0, 150, 255, 0.3)"
					: isHovered()
						? "rgba(0, 0, 0, 0.1)"
						: "transparent",
				"user-select": "none",
				margin: "2px 8px",
				"border-radius": "4px",
			}}
		>
			<img
				src={getIcon()}
				style={{
					width: "16px",
					height: "16px",
					"margin-right": "8px",
				}}
			/>
			<span
				style={{
					"font-size": "13px",
					color: "#333",
					"font-family":
						"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
					overflow: "hidden",
					"text-overflow": "ellipsis",
					"white-space": "nowrap",
					flex: "1",
				}}
			>
				{file.name}
			</span>
			<Show when={isHovered()}>
				<div
					onClick={(e) => {
						e.stopPropagation();
						removeOpenFile(path);
					}}
					style={{
						padding: "0px 4px",
						border: "1px solid rgba(0, 0, 0, 0.2)",
						margin: "0 2px",
						color: "rgba(0, 0, 0, 0.6)",
						"min-width": "16px",
						height: "16px",
						background: "rgba(0, 0, 0, 0.06)",
						"text-align": "center",
						"line-height": "15px",
						cursor: "pointer",
						"border-radius": "3px",
						"font-size": "11px",
						"font-weight": "500",
					}}
					title="Remove from list"
				>
					×
				</div>
			</Show>
		</div>
	);
};

export const OpenFilesTree = () => {
	const openFilesArray = () => {
		return Object.entries(state.openFiles).map(([path, file]) => ({
			path,
			...file,
		}));
	};

	const hasOpenFiles = () => Object.keys(state.openFiles).length > 0;

	return (
		<Show when={hasOpenFiles()}>
			<CategoryRow label="Open Files" />
			<div style={{ "margin-bottom": "12px" }}>
				<For each={openFilesArray()}>
					{(item) => (
						<OpenFileItem
							path={item.path}
							file={{ name: item.name, type: item.type, addedAt: item.addedAt }}
						/>
					)}
				</For>
			</div>
		</Show>
	);
};

export const FileTree = ({
	node,
	readonly = false,
	projectId,
}: {
	node: CachedFileType | PreviewFileTreeType | null;
	readonly?: boolean;
	projectId?: string;
}) => {
	if (node === null) {
		return null;
	}

	const [numResultsToShow, setNumResultsToShow] = createSignal(5);
	const [numResultsHidden, setNumResultsHidden] = createSignal(0);

	const getSearchResults = () => {
		if (projectId && node.path) {
			const results = state.findAllInFolder.results[projectId][node.path];
			// console.log("trimming by", numResultsToShow());
			if ((results.length > numResultsToShow(), results)) {
				const resultsToShow = results.slice(0, numResultsToShow());
				setNumResultsHidden(results.length - numResultsToShow());
				return resultsToShow;
			}
		}

		return [];
	};

	const showChildPreview = () => {
		return (
			state.settingsPane.type === "add-node" &&
			parentNodePath(state.settingsPane.data.node) === node.path
		);
	};
	const expansions = createMemo(() => getWindow(state)?.expansions || []);
	const isExpanded = createMemo(
		() =>
			// previewNode can set isExpanded on the node directly
			("isExpanded" in node && node.isExpanded) ||
			// regular nodes expansions are persisted
			Boolean(expansions().includes(node.path)) ||
			// when adding a child expand the parent to show other children
			showChildPreview() ||
			getSearchResults().length > 0,
	);
	const setIsExpanded = (value: boolean) => {
		// if it's a preview node with isExpanded defined directly on the node
		if ("isExpanded" in node) {
			node.isExpanded = value;
		} else {
			setNodeExpanded(node.path, value);
		}
	};
	const toggleExpanded = (e?: MouseEvent) => {
		if (e) {
			e.stopPropagation();
		}

		if (
			node.type === "dir" &&
			(("previewChildren" in node &&
				Boolean(Object.keys(node.previewChildren).length)) ||
				("children" in node && Boolean(node.children.length)))
		) {
			setIsExpanded(!isExpanded());
		}
	};

	const editNodeSettingsHandler = (e: MouseEvent) => {
		e.stopImmediatePropagation();
		if (!("isExpanded" in node)) {
			// check it's not a previewNode.
			// todo (yoav): there's probably a better way to identity previewNodes
			editNodeSettings(node);
		}
	};

	const newTerminalHandler = (e: MouseEvent) => {
		e.stopPropagation();
		openNewTerminalTab(node.path);
	};

	return (
		<TreeLI node={node}>
			<NodeName
				node={node}
				onLeftActionClick={toggleExpanded}
				isExpanded={isExpanded}
				showChildPreview={showChildPreview}
				newTerminal={newTerminalHandler}
				editNodeSettings={editNodeSettingsHandler}
				readonly={readonly}
			/>

			<Show when={isExpanded()}>
				<TreeUL showLeftBar={true}>
					<Show when={showChildPreview()}>
						<FileTree
							node={
								"previewNode" in state.settingsPane.data
									? state.settingsPane.data.previewNode
									: null
							}
							readonly={readonly}
						/>
					</Show>
					<For each={getFilteredNodeChildren(node)}>
						{(childNode) =>
							childNode ? (
								<FileTree node={childNode} readonly={readonly} />
							) : null
						}
					</For>
					<For each={getSearchResults()}>
						{(searchResult) => {
							// console.log("search result", searchResult);

							const { line, column, match } = searchResult;

							const query = state.findAllInFolder.query;
							const matchIndex = match.indexOf(query);
							const matchStart = match.slice(0, matchIndex);
							const matchEnd = match.slice(matchIndex + query.length);

							const resultNode: PreviewFileNodeType = {
								type: "file",
								name: `${matchStart}${query}${matchEnd}`,
								path: `__BUNNY_INTERNAL__/fileResult:${line}:${column}`,
								persistedContent: "",
								isDirty: false,
								model: null,
								editors: {},
							};

							return (
								<TreeUL>
									{/* <FileTree node={_node} readonly={true}></FileTree> */}
									<TreeLI node={resultNode}>
										<NodeName
											node={resultNode}
											onLeftActionClick={() => {
												openFileAt(node.path, line, column);
												console.log("opening file result");
											}}
											isExpanded={() => false}
											showChildPreview={() => false}
											newTerminal={() => {}}
											editNodeSettings={() => {}}
											readonly={true}
										/>
									</TreeLI>
								</TreeUL>
							);
						}}
					</For>
					{numResultsHidden() > 0 && (
						<TreeUL>
							{/* <FileTree node={_node} readonly={true}></FileTree> */}
							<TreeLI node={null}>
								<div
									style={`cursor: pointer;
                    margin-left: 20px;
                    padding: 5px 10px;
                    font-size: 11px;
                    font-weight: 500;
                    background: rgba(0, 0, 0, 0.04);
                    color: rgba(0, 0, 0, 0.55);
                    border: 1px solid rgba(0, 0, 0, 0.15);
                    border-radius: 4px;
                    transition: all 0.15s ease;
                    user-select: none;
                    -webkit-user-select: none;`}
									onMouseEnter={(e) => {
										e.currentTarget.style.background =
											"rgba(59, 130, 246, 0.12)";
										e.currentTarget.style.borderColor =
											"rgba(59, 130, 246, 0.3)";
										e.currentTarget.style.color = "rgba(59, 130, 246, 0.9)";
									}}
									onMouseLeave={(e) => {
										e.currentTarget.style.background = "rgba(0, 0, 0, 0.04)";
										e.currentTarget.style.borderColor = "rgba(0, 0, 0, 0.15)";
										e.currentTarget.style.color = "rgba(0, 0, 0, 0.55)";
									}}
									onClick={() => {
										setNumResultsToShow(
											numResultsToShow() + numResultsHidden(),
										);
									}}
								>
									{`Show ${numResultsHidden()} more match${numResultsHidden() === 1 ? "" : "es"}`}
								</div>
							</TreeLI>
						</TreeUL>
					)}
				</TreeUL>
			</Show>
		</TreeLI>
	);
};

const TreeUL = ({
	children,
	showLeftBar = false,
}: {
	children: JSX.Element;
	// todo (yoav): show left bar is currently not used. it was used
	// to show a visual helper line to see nested folders. it just
	// needs some style tweaking to look good
	showLeftBar?: boolean;
}) => {
	const [isSelfHovered, setIsSelfHovered] = createSignal(false);
	const [hasHoveredChild, setHasHoveredChild] = createSignal(false);

	// Only show spine when this UL is hovered and no nested TreeUL child is hovered
	const isLeftBarVisible = () => {
		return showLeftBar && isSelfHovered() && !hasHoveredChild();
	};

	return (
		<ul
			style={{
				margin: "0px",
				"margin-left": showLeftBar ? "5px" : "0px",
				"list-style": "none",
				overflow: "show",
			}}
			onMouseEnter={(e) => {
				setIsSelfHovered(true);
				// Notify parent TreeUL that a child is now hovered
				const parentUL = (
					e.currentTarget as HTMLElement
				).parentElement?.closest("ul");
				if (parentUL) {
					parentUL.dispatchEvent(
						new CustomEvent("child-tree-hover", {
							bubbles: false,
							detail: true,
						}),
					);
				}
			}}
			onMouseLeave={(e) => {
				setIsSelfHovered(false);
				setHasHoveredChild(false);
				// Notify parent TreeUL that child is no longer hovered
				const parentUL = (
					e.currentTarget as HTMLElement
				).parentElement?.closest("ul");
				if (parentUL) {
					parentUL.dispatchEvent(
						new CustomEvent("child-tree-hover", {
							bubbles: false,
							detail: false,
						}),
					);
				}
			}}
			// Listen for custom events from child TreeUL elements
			ref={(el) => {
				el.addEventListener("child-tree-hover", ((e: CustomEvent) => {
					setHasHoveredChild(e.detail);
				}) as EventListener);
			}}
		>
			<div
				style={{
					position: "absolute",
					left: "5px",
					top: "28px",
					bottom: "4px",
					width: "2px",
					opacity: 0.3,
					"background-color": isLeftBarVisible() ? "#256491ff" : "transparent",
				}}
			/>
			{children}
		</ul>
	);
};

const TreeLI = ({
	children,
	style = {},
	node,
	...props
}: {
	children: JSX.Element;
	style?: JSX.CSSProperties;
	node: CachedFileType | PreviewFileTreeType;
}) => {
	const isFolderDropTarget = () => {
		return (
			state.dragState?.type === "node" &&
			state.dragState.targetFolderPath === node.path
		);
	};

	return (
		<li
			style={{
				"font-family":
					"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
				margin: "0px",
				padding: "0px 0 0 0px",
				"border-radius": "3px",
				"font-size": "13px",
				cursor: "default",
				position: "relative",
				background: isFolderDropTarget()
					? "rgba(0, 150, 255, 0.2)"
					: "transparent",
				...style,
			}}
			{...props}
		>
			{children}
		</li>
	);
};

const getFilteredNodeChildren = (
	node: CachedFileType | PreviewFileTreeType,
) => {
	if (node.type === "dir") {
		if ("children" in node) {
			// todo (yoav): this should be more robust and support globs
			if (node.path.endsWith("/.git")) {
				return node.children
					.filter((childFilename) => childFilename === "hooks")
					.map((childName) => getNode(join(node.path, childName)));
			}

			return (
				node.children
					// filter out ignored files
					.filter((childFilename) => !childFilename.match(filesToFilter.simple))
					.filter(Boolean)
					.sort()
					// fetch the actual cachedFiles
					.map((childName) => getNode(join(node.path, childName)))
				// filter out nulls in case the file system was out of sync
			);
		}
		if ("previewChildren" in node) {
			return (
				node.previewChildren
					// filter out ignored files
					.filter((child) => !child.name.match(filesToFilter.simple))
			);
		}
	}
};

const NodeName = ({
	node,
	isExpanded,
	onLeftActionClick,
	newTerminal,
	editNodeSettings,
	showChildPreview,
	readonly,
}: {
	node: CachedFileType | PreviewFileTreeType;
	isExpanded: Accessor<boolean>;
	onLeftActionClick: () => void;
	newTerminal: (e: MouseEvent) => void;
	editNodeSettings: (e: MouseEvent) => void;
	showChildPreview: () => boolean;
	readonly: boolean;
}) => {
	// render the edited name of the node if we're editing it
	const nodeToRender = () => {
		if (
			state.settingsPane.type === "edit-node" ||
			state.settingsPane.type === "add-node"
		) {
			if (node.path === state.settingsPane.data?.node?.path) {
				return state.settingsPane.data.previewNode;
			}
		}

		if (node.path.startsWith("__BUNNY_INTERNAL__")) {
			return node;
		}

		return state.fileCache[node.path];
	};

	const [isHovered, setIsHovered] = createSignal(false);
	const [isDragging, setIsDragging] = createSignal(false);
	const [isExpandHovered, setIsExpandHovered] = createSignal(false);

	// Fetch file decoration from plugins
	const [fileDecoration] = createResource(
		() => nodeToRender()?.path,
		async (path) => {
			if (!path || path.startsWith("__BUNNY_INTERNAL__")) return null;
			return getFileDecoration(path);
		},
	);

	const isNodeAncestorBeingEdited = () => {
		if ("node" in state.settingsPane.data) {
			const editedNodePath = state.settingsPane.data.node.path;
			return node.path === editedNodePath;
		}
		return false;
	};

	// todo (yoav): [blocking] how reactive do we need this to be?
	// ie: if the config changes outside of Bunny Dash (eg: from a git pull or something)
	// although we can also just for re-rendering the whole tree in that case
	const slate = () => getSlateForNode(nodeToRender());

	const isSelected = () => {
		const currentTab = getCurrentTab(state);
		return (
			currentTab?.path === nodeToRender().path &&
			!state.settingsPane.type?.includes("node")
		);
	};
	// todo (yoav): debounce this so that we can dedupe double clicks
	const onLaunchClick = (e: MouseEvent) => {
		e.stopPropagation();

		// debugger;
		if (e.detail > 1 && getCurrentTab()?.isPreview) {
			// double click
			setState(
				produce((_state: AppState) => {
					const tab = getCurrentTab(_state);
					if (tab) {
						tab.isPreview = false;
					}
				}),
			);
			updateSyncedState();
			return;
		}

		const _node = nodeToRender();

		if (_node.path.startsWith("__BUNNY_INTERNAL__/fileResult:")) {
			console.log("onLeftActionClick");
			onLeftActionClick();
			return;
		}

		// todo (yoav): move this function to its own slate/pane management file
		const nodeType = nodeToRender().type;
		const slateType = slate()?.type;

		if (nodeType === "file" || (slateType && slateType !== "project")) {
			// Only select existing tab if it's single click. additional clicks eg: double click should open a new tab
			if (e.detail === 1) {
				// todo (yoav): in the future consider including other windows in the search as well

				// Is this tab already open somewhere in the window.
				// First look for a tab in the current pane

				// const currentPane = getCurrentPane(state);
				// there might not be a currentTab if the current pane is empty
				const currentPaneActiveTabNode = getNode(getCurrentTab()?.path);
				const currentProject =
					currentPaneActiveTabNode &&
					getProjectForNode(currentPaneActiveTabNode);
				const nodeToRenderProject = getProjectForNode(nodeToRender());

				// first look at the currrent tab of the current pane
				if (
					currentPaneActiveTabNode &&
					currentProject?.id === nodeToRenderProject?.id &&
					currentPaneActiveTabNode.path === nodeToRender().path
				) {
					// it's the currentPane/tab so it's already focused
					setState(
						produce((_state: AppState) => {
							const tab = getCurrentTab(_state);
							if (tab) {
								tab.isPreview = false;
							}
						}),
					);
					updateSyncedState();
					return;
				}

				const win = getWindow();

				if (!win) {
					return;
				}

				// Then look at the current tab of other panes
				const currentTabSomewhere = Object.values(win.tabs).find((tab) => {
					// todo (yoav): add better typings that node may not exist in stale tabs
					if (!getNode(tab.path)) {
						return false;
					}
					const tabNode = getNode(tab.path);

					if (
						tabNode &&
						getProjectForNode(tabNode)?.id === nodeToRenderProject?.id &&
						tabNode.path === nodeToRender().path
					) {
						const pane = getPaneWithId(state, tab.paneId);

						if (pane?.type !== "pane") {
							return;
						}

						if (pane.currentTabId === tab.id) {
							return true;
						}
					}
				});

				if (currentTabSomewhere) {
					focusTabWithId(currentTabSomewhere.id);
					return;
				}
				// Then look at other tabs in other panes
				const otherTabSomewhere = Object.values(win.tabs).find((tab) => {
					if (!getNode(tab.path)) {
						return false;
					}
					const tabNode = getNode(tab.path);
					if (
						tabNode &&
						getProjectForNode(tabNode)?.id === nodeToRenderProject?.id &&
						tabNode.path === nodeToRender().path
					) {
						return true;
					}
				});

				if (otherTabSomewhere) {
					focusTabWithId(otherTabSomewhere.id);
					return;
				}
			}
		}
		const openAsPreviewTab = !(e.detail > 1);
		openNewTabForNode(nodeToRender().path, openAsPreviewTab);
	};

	const onLiClick = (e: MouseEvent) => {
		const _nodeToRender = nodeToRender();
		const nodeType = _nodeToRender.type;
		const slateType = slate()?.type;

		// slate can be blank if its an internal or previewNode
		if (nodeType === "file" || (slateType && slateType !== "project")) {
			onLaunchClick(e);
		} else if (
			"children" in _nodeToRender &&
			Object.keys(_nodeToRender.children || {}).length
		) {
			onLeftActionClick();
		}
	};

	const onLiContextMenu = (e: MouseEvent) => {
		e.preventDefault();

		const win = getWindow();
		if (!win) {
			return;
		}

		const _nodeToRender = nodeToRender();

		const showContextMenu = async () => {
			const openTabs = Object.values(win.tabs).filter((tab) => {
				const tabNode = getNode(tab.path);
				return (
					tabNode &&
					getProjectForNode(tabNode)?.id ===
						getProjectForNode(_nodeToRender)?.id &&
					tab.path === _nodeToRender.path
				);
			});

			const nearestParentGitRepo = async (path: string) => {
				const isRepoRoot = await electrobun.rpc?.request
					.gitCheckIsRepoRoot({
						repoRoot: _nodeToRender.path,
					})
					.catch((err) => {
						console.log(err);
						return false;
					});

				// const isRepoRoot = await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
				const isInRepoTree = await electrobun.rpc?.request
					.gitCheckIsRepoInTree({
						repoRoot: _nodeToRender.path,
					})
					.catch((err) => {
						console.log(err);
						return false;
					});

				// const isInRepoTree = await git.checkIsRepo(CheckRepoActions.IN_TREE);

				// todo (yoav): bench this to see if it's really faster

				if (isRepoRoot) {
					//   console.log("isRepoRoot", join(path, ".git"));
					return basename(path) === ".git" ? path : join(path, ".git");
				}

				if (isInRepoTree) {
					// console.log("isInRepoTree", await git.revparse(["--show-toplevel"]));
					return await electrobun.rpc?.request
						.gitRevParse({
							repoRoot: _nodeToRender.path,
							options: ["--show-toplevel"],
						})
						.catch((err) => {
							console.log(err);
							return false;
						});
					// return await git.revparse(["--show-toplevel"]);
				}

				// Note: we can use rev-parse --is-inside-work-tree or simplegit's wrappers to check if
				// we're in a git repo, but it doesn't work inside the .git folder itself
				const ancestorGitSegements = path.split("/.git/");

				if (ancestorGitSegements.length === 1) {
					return false;
				}

				let currentPath = "";
				let nearestRepoRoot;
				for (let i = 0; i < ancestorGitSegements.length; i++) {
					const segment = ancestorGitSegements[i];
					currentPath = join(currentPath, segment);
					const gitPathToCheck = join(currentPath, ".git");

					// git.cwd(gitPathToCheck);

					// const isRepoRoot = await git.checkIsRepo(
					//   CheckRepoActions.IS_REPO_ROOT
					// );
					const isRepoRoot = await electrobun.rpc?.request
						.gitCheckIsRepoRoot({
							repoRoot: gitPathToCheck,
						})
						.catch((err) => {
							console.log(err);
							return false;
						});

					if (isRepoRoot) {
						nearestRepoRoot = gitPathToCheck;
						break;
					}
				}

				return nearestRepoRoot || false;
			};

			const firstNestedGitRepo = async (path: string) => {
				try {
					// Use vendored fd binary for fast searching with timeout
					// This searches the entire tree to prevent nested git repos
					const gitPath = await electrobun.rpc?.request.findFirstNestedGitRepo({
						searchPath: path,
						timeoutMs: 5000, // 5 second timeout
					});

					return gitPath || false;
				} catch (error) {
					console.log(error);
					return false;
				}
			};

			// const unwrappedNodeToRender = unwrap(_nodeToRender);

			const menuItems = [
				...openTabs.map((tab, index) => ({
					label: `Focus Tab (${index + 1})`,
					...createContextMenuAction("focus_tab", {
						tabId: tab.id,
					}),
				})),

				{ type: "separator", visible: Boolean(openTabs.length) },

				{
					label: "Open in New Tab",
					hidden: !(
						_nodeToRender.type === "file" ||
						Boolean(getSlateForNode(_nodeToRender))
					),
					...createContextMenuAction("open_new_tab", {
						nodePath: _nodeToRender.path,
					}),
				},

				{
					label: "Open as Text",
					hidden: !(
						_nodeToRender.type === "file" &&
						Boolean(getSlateForNode(_nodeToRender))
					),
					...createContextMenuAction("open_as_text", {
						nodePath: _nodeToRender.path,
					}),
				},

				{
					label: "Copy Path to Clipboard",
					...createContextMenuAction("copy_path_to_clipboard", {
						nodePath: _nodeToRender.path,
					}),
				},

				// should show what settings "type" it is
				{
					label: "Show Node Settings",
					hidden: readonly,
					...createContextMenuAction("show_node_settings", {
						nodePath: _nodeToRender.path,
					}),
				},

				{ type: "separator", visible: Boolean(openTabs.length) },
				// Add different node types for folders
				{
					label: "Add File",
					hidden: readonly || node.type !== "dir",
					...createContextMenuAction("add_child_file", {
						nodePath: _nodeToRender.path,
					}),
				},
				{
					label: "Add Folder",
					hidden: readonly || node.type !== "dir",
					...createContextMenuAction("add_child_folder", {
						nodePath: _nodeToRender.path,
					}),
				},
				{
					label: "Add Browser Profile",
					hidden: readonly || node.type !== "dir",
					...createContextMenuAction("add_child_web", {
						nodePath: _nodeToRender.path,
					}),
				},
				{
					label: "Add AI Agent",
					hidden: readonly || node.type !== "dir",
					...createContextMenuAction("add_child_agent", {
						nodePath: _nodeToRender.path,
					}),
				},
				{
					label: "New Terminal",
					hidden: readonly || node.type !== "dir",
					...createContextMenuAction("new_terminal", {
						nodePath: _nodeToRender.path,
					}),
				},
				{ type: "separator", visible: Boolean(openTabs.length) },
				{
					label: "Rename",
					hidden: readonly,
					...createContextMenuAction("show_node_settings", {
						nodePath: _nodeToRender.path,
					}),
				},

				// Special file creation for different node types
				{
					label: "Edit preload script",
					hidden: readonly || getSlateForNode(_nodeToRender)?.type !== "web",
					...createContextMenuAction("create_preload_file", {
						nodePath: _nodeToRender.path,
					}),
				},
				{
					label: "Create .context.md",
					hidden: readonly || getSlateForNode(_nodeToRender)?.type !== "agent",
					...createContextMenuAction("create_context_file", {
						nodePath: _nodeToRender.path,
					}),
				},

				{ type: "separator", hidden: !openTabs.length },
				{
					label: "Init Git",
					hidden: !(
						node.type === "dir" &&
						!(await nearestParentGitRepo(_nodeToRender.path)) &&
						!(await firstNestedGitRepo(_nodeToRender.path))
					),
					...createContextMenuAction("init_git_in_folder", {
						nodePath: _nodeToRender.path,
					}),
				},
				{
					label: "Clone Repo",
					hidden: !(node.type === "dir"),
					...createContextMenuAction("clone_repo_to_folder", {
						nodePath: _nodeToRender.path,
					}),
				},
				{
					type: "separator",
				},
				{
					label: "Open in Finder",
					hidden: readonly,
					...createContextMenuAction("open_node_in_finder", {
						nodePath: _nodeToRender.path,
					}),
				},
				{
					type: "separator",
				},
			];

			// Fetch and add plugin context menu items
			try {
				const pluginMenuItems =
					await electrobun.rpc?.request.pluginGetContextMenuItems({
						context: "fileTree",
					});
				if (pluginMenuItems && pluginMenuItems.length > 0) {
					menuItems.push(
						...pluginMenuItems.map((item) => ({
							label: item.label,
							accelerator: item.shortcutHint,
							...createContextMenuAction("plugin_context_menu_item", {
								itemId: item.id,
								filePath: _nodeToRender.path,
							}),
						})),
						{ type: "separator" },
					);
				}
			} catch (err) {
				console.warn("Failed to fetch plugin context menu items:", err);
			}

			// Check if this node is a project root (its path exactly matches a project's path)
			const nodeIsProjectRoot = isProjectRoot(_nodeToRender);
			const projectForRoot =
				nodeIsProjectRoot && _nodeToRender?.path
					? getProjectByRootPath(_nodeToRender.path)
					: null;

			menuItems.push(
				{
					label: "Remove Project from Bunny Dash",
					hidden: readonly || !nodeIsProjectRoot,
					...createContextMenuAction("remove_project_from_bunny_dash", {
						projectId: projectForRoot?.id,
					}),
				},
				{
					label: "Delete Node from Disk",
					hidden: readonly || nodeIsProjectRoot,
					...createContextMenuAction("fully_delete_node_from_disk", {
						nodePath: _nodeToRender?.path,
						projectId: nodeIsProjectRoot ? projectForRoot?.id : undefined,
					}),
				},
			);

			await electrobun.rpc?.request.showContextMenu({
				menuItems,
			});
		};
		showContextMenu();
	};

	const onLiDblClick = (e: MouseEvent) => {
		console.info("double click");
	};

	const hasSlate = () => !!slate;

	const focusedTabBackground = () => {
		if (isNodeAncestorBeingEdited()) {
			return "rgba(0, 150, 255, 0.3)";
		}
		if (isSelected()) {
			return "rgba(0, 150, 255, 0.3)";
		}
		if (isHovered()) {
			return "rgba(0, 0, 0, 0.1)";
		}
		return "transparent";
	};

	const isExpandActive = () => {
		if (isExpandHovered()) {
			return true;
		}

		if (slate()?.type) {
			if (slate()?.type === "project") {
				return true;
			}

			if (isHovered()) {
				return false;
			}
		}

		return true;
	};

	const isDirty = () => {
		const _nodeToRender = nodeToRender();

		if (_nodeToRender && "isDirty" in _nodeToRender) {
			return _nodeToRender.isDirty;
		}

		return false;
	};

	const usePointer = () => {
		return (
			nodeToRender().type !== "file" &&
			getSlateForNode(nodeToRender()) &&
			getSlateForNode(nodeToRender())?.type !== "project"
		);
	};

	return (
		<span
			draggable={true}
			onDragStart={(e) => {
				const _nodeToRender = nodeToRender();

				if (!_nodeToRender) {
					return;
				}

				setIsDragging(true);
				setIsHovered(false);
				setState("dragState", {
					type: "node",
					nodePath: _nodeToRender.path,
				});
			}}
			onDragOver={(e) => {
				e.preventDefault(); // Required to allow drop
				const _node = nodeToRender();

				const dragState = state.dragState;
				if (dragState && dragState.type === "node") {
					console.log(
						"drag over",
						_node.type === "dir",
						dragState.nodePath !== _node.path,
						dragState.isTemplate
							? "template (skip descendant check)"
							: !isDescendantPath(dragState.nodePath, _node.path),
					);
					if (_node.type === "dir") {
						// Template nodes can never be descendants of real folders, so skip the check
						const isNotDescendant =
							dragState.isTemplate ||
							!isDescendantPath(dragState.nodePath, _node.path);

						if (dragState.nodePath !== _node.path && isNotDescendant) {
							setState(
								produce((_state: AppState) => {
									if (_state.dragState?.type === "node") {
										_state.dragState.targetPaneId = null;
										_state.dragState.targetFolderPath = _node.path;
									}
								}),
							);
						} else {
							setState(
								produce((_state: AppState) => {
									if (_state.dragState?.type === "node") {
										_state.dragState.targetPaneId = null;
										_state.dragState.targetFolderPath = null;
									}
								}),
							);
						}
					} else {
						if (_node.path === dragState.nodePath) {
							setState(
								produce((_state: AppState) => {
									if (_state.dragState?.type === "node") {
										_state.dragState.targetPaneId = null;
										_state.dragState.targetFolderPath = null;
									}
								}),
							);
						} else {
							const newTargetFolder = dirname(_node.path);
							setState(
								produce((_state: AppState) => {
									if (_state.dragState?.type === "node") {
										_state.dragState.targetPaneId = null;
										_state.dragState.targetFolderPath = newTargetFolder;
									}
								}),
							);
						}
					}
				}
			}}
			onDragEnd={async (e) => {
				setIsDragging(false);
				if (state.dragState) {
					if (state.dragState.type !== "node") {
						return;
					}
					// todo (yoav): we should use node path instead of the node
					// if a filesystem change causes the drag node to get out of sync
					// with the actual file/folder/node/slate on disk it might try
					// open a tab to a certain file type or slate type that no longer exists
					// and lead to bugs
					const { targetPaneId, targetTabIndex, nodePath } = state.dragState;
					const settingsPaneData = state.settingsPane.data;
					const node =
						getNode(nodePath) ||
						("previewNode" in settingsPaneData && settingsPaneData.previewNode);

					if (!node) {
						return;
					}

					if (state.dragState.targetPaneId) {
						// open a new tab for node
						setState(
							produce((_state: AppState) => {
								const win = getWindow(_state);
								if (!win) {
									return;
								}

								win.currentPaneId = targetPaneId || "";
							}),
						);
						debugger;
						// Check if it's a folder without a slate OR a project node - if so, open terminal
						const slate = getSlateForNode(node);
						if (node.type === "dir" && (!slate || slate.type === "project")) {
							// Open terminal tab for folders without slates or project folders
							openNewTerminalTab(node.path, {
								targetPaneId: targetPaneId,
								targetTabIndex: targetTabIndex,
							});
						} else {
							// Open regular tab for files or folders with slates
							openNewTabForNode(node.path, false, {
								targetPaneId: targetPaneId,
								targetTabIndex: targetTabIndex,
							});
						}
					} else if (state.dragState.targetFolderPath) {
						const { targetFolderPath } = state.dragState;
						const currentBasePath = dirname(nodePath);
						if (currentBasePath === targetFolderPath) {
							// moving it to the same folder, so nothing to do
							return;
						}

						// this will make sure we get a new path that doesn't already exist
						const uniqueFileName =
							await electrobun.rpc?.request.getUniqueNewName({
								parentPath: targetFolderPath,
								baseName: node.name,
							});
						const newPath = join(targetFolderPath, uniqueFileName);

						setNodeExpanded(targetFolderPath, true);

						// When dragging a regular node we can rename it
						// renaming the actual file on disk will trigger a file watcher event
						// and update the file tree accordingly
						electrobun.rpc?.request.rename({ oldPath: node.path, newPath });

						// When dragging a previewNode there's no file on disk yet, we just
						// want to reparent it
						if ("previewNode" in settingsPaneData) {
							if (settingsPaneData.previewNode.path === nodePath) {
								setState(
									produce((_state: AppState) => {
										if ("previewNode" in _state.settingsPane.data) {
											const previewNode = _state.settingsPane.data.previewNode;

											previewNode.path = newPath;
											previewNode.name = uniqueFileName;
										}

										if ("node" in _state.settingsPane.data) {
											const originalNode = _state.settingsPane.data.node;

											originalNode.path = newPath;
											originalNode.name = uniqueFileName;
										}
									}),
								);
							}
						}
					}
				}
				setState("dragState", null);
			}}
			onClick={onLiClick}
			onDblClick={onLiDblClick}
			onContextMenu={onLiContextMenu}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
			style={{
				"-webkit-user-select": "none",
				display: "flex",
				"text-overflow": "ellipsis",
				width: "100%",
				overflow: "hidden",
				// background: focusedTabBackground(),

				cursor: usePointer() ? "pointer" : "default",
			}}
		>
			<span
				style={{
					background: focusedTabBackground(),
					transition: "background-color 0.25s ease-out",
					position: "absolute",
					top: "0px",
					right: "0px",
					height: "23px",
					left: "-100px",
				}}
			/>
			<span
				style={{
					padding: "0px 4px 0 5px",
					width: "8px",
					height: "23px",
					"margin-left": "0px",
					color: "#666",
					background: "transparent",
					display: "flex",
					"align-items": "center",
					opacity: isExpandActive() ? "1" : "0.2",
				}}
			>
				<div
					style={{
						width: "8px",
						...(true
							? {
									rotate:
										(isExpandActive() && isHovered()) || isExpandHovered()
											? isExpanded()
												? "-5deg"
												: "5deg"
											: "0deg",
									translate:
										(isExpandActive() && isHovered()) || isExpandHovered()
											? "2px"
											: "0px",
									"transform-origin": "center",
									transition:
										"translate 0.1s ease-in-out, rotate 0.2s ease-in-out",
								}
							: {}),
					}}
					onClick={onLeftActionClick}
				>
					<Show
						when={
							getFilteredNodeChildren(nodeToRender())?.length ||
							showChildPreview()
						}
					>
						<img
							width={10}
							height={10}
							src={`views://assets/file-icons/folder-arrow-down.svg`}
							style={{
								rotate: isExpanded() ? "0deg" : "-90deg",
							}}
						/>
					</Show>
				</div>
			</span>
			<span
				style={{
					padding: "0",
					overflow: "show",
					width: "100%",
					"text-overflow": "ellipsis",
					position: "relative",
					display: "flex",
					"align-items": "center",
				}}
			>
				<div
					style={{
						width: "16px",
						height: "23px",
						display: "flex",
						"margin-right": "5px",
						"align-items": "center",
					}}
				>
					<img src={getIconForNode(nodeToRender())} width="16" height="16" />
				</div>

				<span
					style={{
						display: "flex",
						cursor: hasSlate() ? "pointer" : "default",
					}}
				>
					<span
						style={{
							color: fileDecoration()?.color || "#333",
							background: "transparent",
							opacity: fileDecoration()?.faded ? 0.5 : 1,
						}}
					>
						{(() => {
							const slate = getSlateForNode(nodeToRender());
							const node = nodeToRender();

							// If we're hovering and it's a slate with a different display name, show folder name
							if (
								isHovered() &&
								slate &&
								slate.name &&
								slate.name !== node.name
							) {
								return slate?.name || node.name;
							}

							// Otherwise show the display name (slate name or folder name)
							return node.name;
						})()}
					</span>

					<Show when={isDirty()}>
						<span
							style={{
								"margin-left": "5px",
								"font-weight": "bold",
								"font-size": "20px",
								"line-height": "12px",
								"margin-top": "2px",
							}}
						>
							•
						</span>
					</Show>

					{/* Plugin file decoration badge */}
					<Show when={fileDecoration()?.badge}>
						<span
							style={{
								"margin-left": "4px",
								"font-size": "11px",
								color: fileDecoration()?.badgeColor || "#666",
							}}
							title={fileDecoration()?.tooltip}
						>
							{fileDecoration()?.badge}
						</span>
					</Show>
				</span>

				<Show when={!readonly}>
					<div style="position: absolute; display: flex; top: 0px; right: 0px; left: 0px; height: 23px; align-items: center; justify-content: right;">
						<Show when={isHovered()}>
							<FileTreeItemControlButton
								label="..."
								onClick={editNodeSettings}
							/>
						</Show>
					</div>
				</Show>
				<div
					style="position: absolute; left: 0px; bottom: 0px; top: 0px; cursor: default; "
					onClick={onLeftActionClick}
				>
					<div
						style="position: absolute; right: 0px; bottom: 0px;top: 0px; width: 100px"
						onMouseOver={() => setIsExpandHovered(true)}
						onMouseOut={() => setIsExpandHovered(false)}
					/>
				</div>
			</span>
		</span>
	);
};

export const FileTreeItemControlButton = ({
	label,
	onClick,
	title,
}: {
	label: string;
	title?: string;
	onClick: (e: DomEventWithTarget<MouseEvent>) => void;
}) => {
	const [isHovered, setIsHovered] = createSignal(false);

	return (
		<div
			title={title}
			style={{
				padding: "0px 4px",
				border: isHovered()
					? "1px solid rgba(59, 130, 246, 0.4)"
					: "1px solid rgba(0, 0, 0, 0.2)",
				margin: "0 2px",
				color: isHovered() ? "rgba(59, 130, 246, 0.9)" : "rgba(0, 0, 0, 0.6)",
				"min-width": "16px",
				height: "16px",
				background: isHovered()
					? "rgba(59, 130, 246, 0.15)"
					: "rgba(0, 0, 0, 0.06)",
				"text-align": "center",
				"line-height": "15px",
				opacity: 1,
				cursor: "pointer",
				"border-radius": "3px",
				transition: "all 0.15s ease",
				"font-size": "11px",
				"font-weight": "500",
			}}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
			onClick={onClick}
		>
			{label}
		</div>
	);
};

// - both files and folders can also be slates
// - you should always show the folder/file icon as well as the slate icon if it exists
// - hover interactions indicate what will happen when you click on the file name. you have to go out of your way to edit the raw file or open the raw folder
// when there's an slate involved.

export const getIconForNode = (
	node: CachedFileType | PreviewFileTreeType,
): string => {
	if (node.type === "dir") {
		const slate = getSlateForNode(node);

		// For project slates, always use the regular folder icon
		if (slate?.type === "project") {
			return `views://assets/file-icons/folder.svg`;
		}

		// For other slates with custom icons, use them
		if (slate?.icon) {
			return slate.icon;
		}

		// Special case for .git folders
		const name = node.name;
		if (name === ".git") {
			return `views://assets/file-icons/git.png`;
		}

		// Default folder icon
		return `views://assets/file-icons/folder.svg`;
	}

	if (node.type === "file") {
		const ext = node.name.split(".").pop();
		if (ext === "ts" || ext === "tsx") {
			return `views://assets/file-icons/tsx.svg`;
		}

		if (ext === "css") {
			return `views://assets/file-icons/css.svg`;
		}

		if (ext === "js") {
			return `views://assets/file-icons/js.svg`;
		}

		if (ext === "json" || ext === "lock") {
			return `views://assets/file-icons/json.svg`;
		}

		if (
			ext === "ico" ||
			ext === "jpg" ||
			ext === "jpeg" ||
			ext === "png" ||
			ext === "svg" ||
			ext === "gif" ||
			ext === "webp" ||
			ext === "tiff" ||
			ext === "tif" ||
			ext === "bmp" ||
			ext === "jfif"
		) {
			return `views://assets/file-icons/json.svg`;
		}

		if (ext === "md") {
			return `views://assets/file-icons/markdown.svg`;
		}

		return `views://assets/file-icons/txt.svg`;
	}

	return `views://assets/file-icons/txt.svg`;
};

export const FindAllResultsTree = () => {
	const projectsWithResultsAsArray = () => {
		return Object.keys(state.findAllInFolder.results).map(
			(projectId) => state.projects[projectId],
		);
	};

	// console.log("----> ", projectsWithResultsAsArray(), resultsArray());

	return (
		<>
			<CategoryRow label="Find all results" />
			<For each={projectsWithResultsAsArray()}>
				{(project) => {
					if (!project) {
						return;
					}

					const projectNode = () => {
						const _projectNode = getNode(project.path);
						return _projectNode || null;
					};

					const _projectNode = projectNode();

					return (
						<TreeUL>
							<FindAllResultProjectTree
								projectId={project.id}
								projectNode={_projectNode}
							/>
						</TreeUL>
					);
				}}
			</For>
		</>
	);
};

const FindAllResultProjectTree = ({ projectId, projectNode }) => {
	const [isExpanded, setIsExpanded] = createSignal(true);

	const numResultsToIncremenet = 5;
	const [numResultsToShow, setNumResultsToShow] = createSignal(5);
	const [numResultsHidden, setNumResultsHidden] = createSignal(0);

	const getSearchResults = () => {
		if (projectId) {
			const results = Object.keys(state.findAllInFolder.results[projectId]);

			if ((results.length > numResultsToShow(), results)) {
				const resultsToShow = results.slice(0, numResultsToShow());
				setNumResultsHidden(results.length - numResultsToShow());
				return resultsToShow;
			}
		}

		return [];
	};

	return (
		<TreeLI node={projectNode}>
			<NodeName
				node={projectNode}
				onLeftActionClick={() => {
					setIsExpanded(!isExpanded());
				}}
				isExpanded={isExpanded}
				showChildPreview={() => false}
				newTerminal={() => {}}
				editNodeSettings={() => {}}
				readonly={true}
			/>

			<Show when={isExpanded()}>
				<TreeUL showLeftBar={true}>
					<For each={getSearchResults()}>
						{(childPath) => {
							const childNode = getNode(childPath);

							return childNode ? (
								<FileTree
									node={childNode}
									readonly={true}
									projectId={projectId}
								/>
							) : null;
						}}
					</For>
				</TreeUL>
				{numResultsHidden() > 0 && (
					<div
						style={`cursor: pointer;
              margin-left: 20px;
              padding: 5px 10px;
              font-size: 11px;
              font-weight: 500;
              background: rgba(0, 0, 0, 0.04);
              color: rgba(0, 0, 0, 0.55);
              border: 1px solid rgba(0, 0, 0, 0.15);
              border-radius: 4px;
              transition: all 0.15s ease;
              user-select: none;
              -webkit-user-select: none;`}
						onMouseEnter={(e) => {
							e.currentTarget.style.background = "rgba(59, 130, 246, 0.12)";
							e.currentTarget.style.borderColor = "rgba(59, 130, 246, 0.3)";
							e.currentTarget.style.color = "rgba(59, 130, 246, 0.9)";
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.background = "rgba(0, 0, 0, 0.04)";
							e.currentTarget.style.borderColor = "rgba(0, 0, 0, 0.15)";
							e.currentTarget.style.color = "rgba(0, 0, 0, 0.55)";
						}}
						onClick={() => {
							setNumResultsToShow(numResultsToShow() + numResultsToIncremenet);
						}}
					>
						{`Show ${numResultsToIncremenet} more file${numResultsToIncremenet === 1 ? "" : "s"} (${numResultsHidden()} hidden)`}
					</div>
				)}
			</Show>
		</TreeLI>
	);
};
