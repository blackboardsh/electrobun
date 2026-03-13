import type * as monaco from "monaco-editor";
import { createEffect, untrack } from "solid-js";
import { createStore, produce, unwrap } from "solid-js/store";
import type * as PathsNamespace from "../../main/consts/paths";
import { type CurrentDocumentTypes } from "../../main/goldfishdb/db";
import type {
  CachedFileType,
  PanePathType,
  PreviewFileTreeType,
  SlateType,
} from "../../shared/types/types";
import { getNode } from "./FileWatcher";
import { getSlateForNode } from "./files";
import { electrobun } from "./init";
import { trackFrontend } from "./analytics";

// export type PreviewFileTreeType = FileTreeType<{
//   isExpanded: boolean;
//   slate?: SlateType;
// }>;

export type WindowType = {
  id: string;
  ui: {
    showSidebar: boolean;
    sidebarWidth: number;
  };
  position: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  // which folders are expanded in this particular window
  // todo (yoav): [blocking] this can become out of date if you expand a folder and then
  // the folder is no longer there, make sure we're cleaning this up somehwere. maybe already done in filewatcher
  expansions: string[];
  rootPane: PaneLayoutType;
  currentPaneId: string;
  tabs: { [tabId: string]: TabType };
};

// todo (yoav): [blocking] deriving workspace from the schema requires a lot more goldfishdb functionality
// so for now we want to try to make them match as much as possible
export type WorkspaceType = {
  id: string;
  name: string;
  color: string;
  windows: Array<WindowType>;
};

export type BaseTabType = {
  id: string;
  // todo (yoav): path should only be on file and browser profile tabs
  // it's a big typescript change though
  path: string;
  // whether the tab sticks when selecting another file or pane or not
  isPreview: boolean;
  // what pane this tab belongs to
  paneId: string;
};

// todo (yoav): maybe there's a web tab without a node path
// and a browser profile tab with a node path
export interface WebTabType extends BaseTabType {
  type: "web";
  url: string;
  title?: string;
}

export interface FileTabType extends BaseTabType {
  type: "file";
  forceEditor?: boolean; // Open as text editor even if file has a slate
}

export interface TerminalTabType extends BaseTabType {
  type: "terminal";
  cwd: string;
  cmd: string;
  args: string[];
  terminalId?: string;
}

export interface AgentTabType extends BaseTabType {
  type: "agent";
  title?: string;
}

export type TabType = FileTabType | WebTabType | TerminalTabType | AgentTabType;

export type LayoutPaneType = {
  id: string;
  tabIds: Array<string>;
  currentTabId: null | string;
  type: "pane";
};

export type LayoutContainerType = {
  id: string;
  direction: "row" | "column";
  divider: number; // percentage
  panes: Array<LayoutPaneType | LayoutContainerType>;
  type: "container";
};

export type PaneLayoutType = LayoutPaneType | LayoutContainerType;

// todo: dedupe move to shared file
export const getUniqueId = () => {
  return String(Date.now() + Math.random());
};

// todo (yoav): [blocking] for the state properties that sync to the database, we should have a function
// like updateSyncedState() that updates the state in the browser and sends a message to the main
// to be saved into the database. That way we can get from the server without triggering a circular flow

export const updateSyncedState = () => {
  // stateUpdater();

  setTimeout(() => {
    electrobun.rpc?.request.syncWorkspace({
      workspace: unwrap(state.workspace),
    });
  });
};

export const updateSyncedAppSettings = () => {
  setTimeout(() => {
    electrobun.rpc?.request.syncAppSettings({
      appSettings: unwrap(state.appSettings),
    });
  });
};

export interface AppState {
  port: null | MessagePort;
  buildVars: {
    channel: "stable" | "canary" | "dev" | "";
    version: string;
    hash: string;
  };
  update: {
    // YYY - updater anys were UpdaterEvents, UpdateInfo, and Progress info was from electron updator
    status: any | null;
    info: any | null;
    progress: any | null;
    downloadedFile: boolean;
    error: null | {
      message: string;
      stack: string;
    };
  };
  // XXX
  paths: typeof PathsNamespace | null;
  // paths: {};
  peerDependencies: {
    // globalBun: {
    //   installed: boolean;
    //   version: string;
    // };
    bun: {
      installed: boolean;
      version: string;
    };
    typescript: {
      installed: boolean;
      version: string;
    };
    biome: {
      installed: boolean;
      version: string;
    };
    // homebrew: {
    //   installed: boolean;
    //   version: string;
    // };
    git: {
      installed: boolean;
      version: string;
    };
  };
  // the workspace that this window is a part of
  // todo (yoav): [blocking] make sharing types with the database cleaner
  // todo (yoav): [blocking] more clearly separate local ephemeral state from synced state
  // todo (yoav): [blocking] make workspaces singular in the db
  workspace: WorkspaceType; //CurrentDocumentTypes['workspaces']
  projects: { [id: string]: CurrentDocumentTypes["projects"] };
  tokens: any[];
  // the current window id. This doesn't change for the life of the window
  windowId: string;
  ui: {
    showSidebar: boolean;
    showWorkspaceMenu: boolean;
    showAppMenu: boolean;
    filterFileTreeByFindAll: boolean;
    showCommandPalette: boolean;
  };
  // Toggle on delegate mode when the settings pane is open
  // Electrobun's Delegate mode hides the native hovering webview while showing
  // a background image of its current contents. This lets us layer the settings pane
  // and other ui over the <electron-webview> without it being obscured by the native webview
  webSlateDelegateMode: boolean;
  settingsPane:
    | {
        type: "";
        data: {};
      }
    | {
        type: "add-node" | "edit-node";
        data: {
          node: CachedFileType | PreviewFileTreeType;
          previewNode: PreviewFileTreeType;
          selectedNodeType?: string;
        };
      }
    | {
        // todo (yoav): may separate these out if they need to store metadata later
        type: "global-settings" | "workspace-settings" | "llama-settings" | "github-settings" | "colab-cloud-settings" | "plugin-marketplace";
        data: {};
      };

  // authUrl: string | null;
  githubAuth: {
    authUrl: null | string;
    resolver: null | (() => void);
  };
  accessToken: string | null;
  // fileTrees: { [projectId: string]: FileTreeType };
  fileCache: { [absolutePath: string]: CachedFileType };
  // Slates is a cache of .colab.json config files. There are other types of slates.
  // unlike some other slates like package.json, These slates are configs for the parent folders
  // typically turning the parent folder into a clickable web browser profile or portal dashboard
  // when needed for a particular folder it's read from disk and cached here, we then listen
  // to filchange events (eg: from a git pull) and update the cache if it exists
  slateCache: { [absolutePath: string]: SlateType };

  // Plugin slates loaded from the plugin system - these provide custom file handlers
  // registered by plugins (e.g., webflow-plugin for .webflowrc.json files)
  pluginSlates: Array<{
    id: string;
    pluginName: string;
    name: string;
    description?: string;
    icon?: string;
    patterns: string[];
    folderHandler?: boolean;
  }>;

  // directoryWatchers: { [projectId: string]: any };
  dragState:
    | null
    | {
        type: "tab";
        // the tab or node id
        id: string;
        // node?: FileTreeType;
        targetPaneId: null | string;
        targetTabIndex: number;
      }
    | {
        type: "node";
        nodePath: string;
        // node: FileTreeType;
        targetPaneId: null | string;
        targetTabIndex: number;
        targetFolderPath: null | string;
        targetTabId?: null | string;
        isTemplate?: boolean;
        templateId?: string;
      };
  isResizingPane: boolean;
  // todo: consider moving editors onto the tab object. since goToLine and goToUrl in tab, could just
  // use the tab.editor etc. and other methods
  editors: {
    [editorId: string]: {
      tabId: string;
      editor: monaco.editor.IStandaloneCodeEditor;
      handleTsServerResponse: (response: any) => void;
    };
  };
  // a simple way to subscribe to the last fileWatchEvent and
  // react to what file changed
  lastFileChange: string;

  findAllInFolder: {
    query: string;
    results: {
      [projectId: string]: {
        [path: string]: {
          line: number;
          column: number;
          match: string;
        }[];
      };
    };
  };
  commandPalette: {
    query: string;
    results: {
      [projectId: string]: string[];
    };
  };
  // Files opened outside of any project (via edit command, Open menu, or drag-drop)
  openFiles: {
    [absolutePath: string]: {
      name: string;
      type: 'file' | 'dir';
      addedAt: number;
    };
  };
  appSettings: {
    analyticsEnabled?: boolean;
    analyticsConsentPrompted?: boolean;
    llama: {
      enabled: boolean;
      baseUrl: string;
      model: string;
      temperature: number;
      inlineEnabled: boolean;
    };
    github: {
      accessToken: string;
      username: string;
      connectedAt: number | undefined;
      scopes: string[];
    };
    colabCloud: {
      accessToken: string;
      refreshToken: string;
      userId: string;
      email: string;
      name: string;
      emailVerified: boolean;
      connectedAt: number | undefined;
    };
  };
  // Download notifications for web slates
  downloadNotification: {
    visible: boolean;
    filename: string;
    path: string;
    status: 'downloading' | 'completed' | 'failed';
    progress?: number; // 0-100 percentage
    error?: string;
  } | null;
}

const initialState: AppState = {
  port: null,
  buildVars: { channel: "", version: "" },
  update: {
    status: null,
    info: null,
    progress: null,
    downloadedFile: false,
    error: null,
  },
  peerDependencies: {
    // globalBun: {
    //   installed: false,
    //   version: "",
    // },
    bun: {
      installed: false,
      version: "",
    },
    typescript: {
      installed: false,
      version: "",
    },
    biome: {
      installed: false,
      version: "",
    },
    // homebrew: {
    //   installed: false,
    //   version: "",
    // },
    git: {
      installed: false,
      version: "",
    },
  },
  paths: null,
  projects: {},

  tokens: [],
  ui: {
    showSidebar: true,
    showWorkspaceMenu: false,
    showAppMenu: false,
    filterFileTreeByFindAll: false,
    showCommandPalette: false,
  },
  webSlateDelegateMode: false,
  settingsPane: {
    type: "",
    data: {},
  },

  // oauth url to get access token, drives the oauth webview
  // authUrl: null,
  githubAuth: {
    authUrl: null,
    resolver: null,
  },
  // temporarily store the generated access token. this works kind of like an 'engine' for effects
  accessToken: null,
  // directoryWatchers: {},
  // fileTrees: {},
  fileCache: {},
  slateCache: {},
  pluginSlates: [],
  dragState: null,
  isResizingPane: false,
  workspace: {
    id: "",
    name: "",
    color: "",
    windows: [],
  },
  windowId: "",
  editors: {},
  lastFileChange: "",
  findAllInFolder: {
    query: "",
    results: {},
  },
  commandPalette: {
    query: "",
    results: {},
  },
  openFiles: {},
  appSettings: {
    llama: {
      enabled: true,
      baseUrl: "llama.cpp",
      model: "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
      temperature: 0.1,
      inlineEnabled: true,
    },
    github: {
      accessToken: "",
      username: "",
      connectedAt: undefined,
      scopes: [],
    },
    colabCloud: {
      accessToken: "",
      refreshToken: "",
      userId: "",
      email: "",
      name: "",
      emailVerified: false,
      connectedAt: undefined,
    },
  },
  downloadNotification: null,
};

const [state, setState] = createStore(initialState);

export { state, setState };

// todo (yoav): make this a debug only thing
// @ts-ignore - for debugging, the app doesn't need this internally
window.state = () => unwrap(state);

// all state methods and utils should be exported from the store and adjacent files to prevent footguns
// where you try modify global state in a producer function instead of _state. maybe we can use typescript
// to show that it's a readonly object or something

// can we also wire up auto-syncing to the backend? should that be what the goldfishdb client is for

// producers
// todo (yoav): move to their own files and organize
export const setPreviewNodeSlateName = (newName: string) => {
  setState(
    produce((_state: AppState) => {
      const settingsType = _state.settingsPane.type;
      if (settingsType !== "add-node" && settingsType !== "edit-node") {
        return;
      }

      const __previewNode = _state.settingsPane.data.previewNode;
      if (
        __previewNode &&
        __previewNode.type === "dir" &&
        "slate" in __previewNode &&
        __previewNode.slate &&
        "name" in __previewNode.slate
      ) {
        __previewNode.slate.name = newName;
      }
    })
  );
};

export const setPreviewNodeSlateUrl = (newUrl: string) => {
  setState(
    produce((_state: AppState) => {
      const settingsType = _state.settingsPane.type;
      if (settingsType !== "add-node" && settingsType !== "edit-node") {
        return;
      }

      const __previewNode = _state.settingsPane.data.previewNode;
      if (
        __previewNode &&
        __previewNode.type === "dir" &&
        "slate" in __previewNode &&
        __previewNode.slate &&
        "url" in __previewNode.slate
      ) {
        __previewNode.slate.url = newUrl;
      }
    })
  );
};

export const setPreviewNodeSlateIcon = (newIcon: string) => {
  setState(
    produce((_state: AppState) => {
      const settingsType = _state.settingsPane.type;
      if (settingsType !== "add-node" && settingsType !== "edit-node") {
        return;
      }

      const __previewNode = _state.settingsPane.data.previewNode;
      if (
        __previewNode &&
        __previewNode.type === "dir" &&
        "slate" in __previewNode &&
        __previewNode.slate &&
        "icon" in __previewNode.slate
      ) {
        __previewNode.slate.icon = newIcon;
      }
    })
  );
};

export const setPreviewNodeSlateToken = (newToken: string) => {
  setState(
    produce((_state: AppState) => {
      const settingsType = _state.settingsPane.type;
      if (settingsType !== "add-node" && settingsType !== "edit-node") {
        return;
      }

      const __previewNode = _state.settingsPane.data.previewNode;
      if (
        __previewNode &&
        __previewNode.type === "dir" &&
        "slate" in __previewNode &&
        __previewNode.slate &&
        "token" in __previewNode.slate
      ) {
        __previewNode.slate.token = newToken;
      }
    })
  );
};

export const setPreviewNodeSlateConfig = (configUpdate: Record<string, any>) => {
  setState(
    produce((_state: AppState) => {
      const settingsType = _state.settingsPane.type;
      if (settingsType !== "add-node" && settingsType !== "edit-node") {
        return;
      }

      const __previewNode = _state.settingsPane.data.previewNode;
      if (
        __previewNode &&
        __previewNode.type === "dir" &&
        "slate" in __previewNode &&
        __previewNode.slate &&
        "config" in __previewNode.slate
      ) {
        Object.assign(__previewNode.slate.config, configUpdate);
      }
    })
  );
};

export const setPreviewNode = (newNode: PreviewFileTreeType) => {
  setState(
    produce((_state: AppState) => {
      const settingsType = _state.settingsPane.type;
      if (settingsType !== "add-node" && settingsType !== "edit-node") {
        return;
      }

      _state.settingsPane.data.previewNode = newNode;
    })
  );
};

export const getWindow = (_state: AppState = state) => {
  if (
    "windows" in _state.workspace &&
    Array.isArray(_state.workspace.windows)
  ) {
    return _state.workspace.windows.find((w) => w.id === _state.windowId);
  }
};

export const focusTabWithId = (tabId: string) => {
  // todo (yoav): use eslint or something to alert about shadowVars
  // to prevent footguns mixing up state and _state

  setState(
    produce((_state: AppState) => {
      const win = getWindow(_state);

      if (!win) {
        return;
      }

      const tab = win.tabs[tabId];
      const { id, paneId } = tab;
      const pane = getPaneWithId(_state, paneId);

      if (pane?.type !== "pane") {
        return;
      }

      pane.currentTabId = id;
      win.currentPaneId = paneId;
      tab.isPreview = false;
    })
  );
  updateSyncedState();
};

export const getPaneWithId = (_state: AppState, paneId: string) => {
  const rootPane = getRootPane(_state);
  if (rootPane) {
    return walkPanesForId(rootPane, paneId);
  }
};

export const getRootPane = (_state: AppState = state) => {
  return getWindow(_state)?.rootPane;
};

export const walkPanesForId = (pane: PaneLayoutType, id: string) => {
  return walkPanes(pane, (_pane) => _pane.id === id);
};

export const walkPanes = (
  pane: PaneLayoutType,
  fn: (PaneLayoutType: PaneLayoutType) => boolean = (_pane) => false
): PaneLayoutType | undefined => {
  if (fn(pane)) {
    return pane;
  }

  if (pane.type === "container") {
    for (const childPane of pane.panes) {
      const result = walkPanes(childPane, fn);
      if (result) {
        return result;
      }
    }
  }
};

export const getCurrentPane = (_state: AppState = state) => {
  const rootPane = getRootPane(_state);
  const currentPaneId = getWindow(_state)?.currentPaneId;
  if (rootPane && currentPaneId) {
    return walkPanesForId(rootPane, currentPaneId);
  }
};

export const openNewTab = (
  config: Omit<TabType, "id" | "paneId" | "isPreview">,
  makePreviewTab = true,
  opts: {} | { targetPaneId: string; targetTabIndex: number } = {}
) => {
  let newTabId = getUniqueId();
  trackFrontend("tabOpen", {
    type: config.type,
  });

  setState(
    produce((_state: AppState) => {
      const win = getWindow(_state);

      if (!win) {
        return;
      }

      const rootPane = getRootPane(_state);

      if (!rootPane) {
        return;
      }

      const pane =
        "targetPaneId" in opts
          ? walkPanesForId(rootPane, opts.targetPaneId)
          : getCurrentPane(_state) || rootPane;

      if (pane?.type !== "pane") {
        return;
      }

      const { currentTabId } = pane;

      const existingTab = currentTabId ? win.tabs[currentTabId] : null;

      if (makePreviewTab && currentTabId && existingTab?.isPreview) {
        if ("targetPaneId" in opts) {
          // if we're opening a node to a specific pane then just update the current preview Tab
          // to a not-preview tab and open the new one next to it
          win.tabs[currentTabId].isPreview = false;
        } else {
          // if we're clicking through stuff and the current tab is a preview tab,
          // close the old preview tab completely and let a new one be created below.
          // This ensures proper component lifecycle (cleanup, fresh state, etc.)
          delete win.tabs[currentTabId];
          const tabIndex = pane.tabIds.indexOf(currentTabId);
          if (tabIndex !== -1) {
            pane.tabIds.splice(tabIndex, 1);
          }
        }
      }

      const tabId = newTabId;
      const newPreviewTab = {
        id: tabId,
        paneId: pane.id,
        isPreview: makePreviewTab,
        ...config,
      } as TabType;

      win.tabs[tabId] = newPreviewTab;

      if ("targetTabIndex" in opts && typeof opts.targetTabIndex === "number") {
        // Note: splice mutates the array
        pane.tabIds.splice(opts.targetTabIndex, 0, tabId);
      } else {
        pane.tabIds.push(tabId);
      }
      pane.currentTabId = tabId;
    })
  );
  updateSyncedState();

  return newTabId;
};

// This lets you open a new tab associated with a specific node connected to a path
// you can optionally pass in a url to override the slate url for initial load
// todo (yoav): replace all usages with store.openNewTab()
export const openNewTabForNode = (
  path: string,
  isPreview = true,
  opts:
    | {}
    | {
        targetPaneId: string;
        targetTabIndex: number;
        url?: string;
        focusNewTab?: boolean;
      } = { focusNewTab: true }
) => {
  const focusNewTab = "focusNewTab" in opts ? opts.focusNewTab : true;
  const node = getNode(path);
  if (!node) {
    return;
  }
  const slate = getSlateForNode(node);
  const slateType = slate?.type;

  setState(
    produce((_state: AppState) => {
      const win = getWindow(_state);

      if (!win) {
        return;
      }

      const rootPane = getRootPane(_state);

      if (!rootPane) {
        return;
      }

      const pane =
        "targetPaneId" in opts
          ? walkPanesForId(rootPane, opts.targetPaneId)
          : getCurrentPane(_state) || rootPane;

      if (pane?.type !== "pane") {
        return;
      }

      const { currentTabId } = pane;

      const existingTab = currentTabId ? win.tabs[currentTabId] : null;

      if (currentTabId && isPreview && existingTab && existingTab.isPreview) {
        if ("targetPaneId" in opts) {
          // if we're opening a node to a specific pane then just update the current preview Tab
          // to a not-preview tab
          win.tabs[currentTabId] = {
            ...existingTab,
            isPreview: false,
          };
        } else {
          // if we're clicking through stuff and the current tab is a preview tab,
          // close the old preview tab completely and let a new one be created below.
          // This ensures proper component lifecycle (cleanup, fresh state, etc.)
          delete win.tabs[currentTabId];
          const tabIndex = pane.tabIds.indexOf(currentTabId);
          if (tabIndex !== -1) {
            pane.tabIds.splice(tabIndex, 1);
          }
        }
      }

      const targetUrl = "url" in opts ? opts.url : slate?.url;

      const webTabSettings =
        slateType === "web" ? { type: "web" as const, url: targetUrl } : {};
      const agentTabSettings =
        slateType === "agent" ? { type: "agent" as const, title: slate?.name } : {};
      const gitTabSettings =
        slateType === "git" ? { title: slate?.name } : {};
      const tabId = getUniqueId();
      const newPreviewTab: TabType = {
        id: tabId,
        type: "file",
        paneId: pane.id,
        isPreview: isPreview,
        path: node.path,
        ...webTabSettings,
        ...agentTabSettings,
        ...gitTabSettings,
      };

      trackFrontend("tabOpen", {
        type: newPreviewTab.type,
      });

      win.tabs[tabId] = newPreviewTab;

      if ("targetTabIndex" in opts && typeof opts.targetTabIndex === "number") {
        // Note: splice mutates the array
        pane.tabIds.splice(opts.targetTabIndex, 0, tabId);
      } else {
        pane.tabIds.push(tabId);
      }
      if (focusNewTab) {
        pane.currentTabId = tabId;
      }
    })
  );
  updateSyncedState();
};

export const openNewTerminalTab = (
  cwd?: string,
  opts: {} | { targetPaneId: string; targetTabIndex: number } = {}
) => {
  const terminalConfig: TerminalTabType = {
    type: "terminal",
    path: cwd || "/",
    cwd: cwd || "/",
    cmd: "/bin/zsh", // This will be overridden by the terminal manager based on platform
    args: [],
    isPreview: false,
  };

  return openNewTab(terminalConfig, false, opts);
};

export const setNodeExpanded = (nodePath: string, isExpanded: boolean) => {
  setState(
    produce((_state: AppState) => {
      const win = getWindow(_state);
      if (!win) {
        return;
      }
      const expansionsSet = new Set(win.expansions);
      if (isExpanded) {
        expansionsSet.add(nodePath);
      } else {
        expansionsSet.delete(nodePath);
      }

      win.expansions = Array.from(expansionsSet);
    })
  );

  updateSyncedState();
};

export const editNodeSettings = (node: CachedFileType) => {
  if (
    state.settingsPane.type === "edit-node" &&
    state.settingsPane.data.node.path === node.path
  ) {
    setState("settingsPane", { type: "", data: {} });
  } else {

    const delay = untrack(() => {
      return state.settingsPane.type ? 400 : 0;
    })

    setState("settingsPane", {
      type: "",
      data: {}
    })        
    setTimeout(async () => {
      // const nodeType = state.settingsPane.type === 'edit-node' || state.settingsPane.type === 'edit-node' && state.settingsPane.data.node.type
      if (node.type === "file") {
        setState("settingsPane", {
          type: "edit-node",
          data: {
            node,
            previewNode: {
              ...node,
            },
          },
        });
      } else if (node.type === "dir") {
        setState("settingsPane", {
          type: "edit-node",
          data: {
            node,
            previewNode: {
              ...node,
              isExpanded: false,
              children: [],
              slate: getSlateForNode(node),
            },
          },
        });
      }
    }, delay);
  }
};

export const getCurrentTab = (_state: AppState = state) => {
  const pane = getCurrentPane(_state);
  if (pane?.type !== "pane") {
    return null;
  }
  // todo (yoav): [blocking] rename this currentTabId
  const { currentTabId } = pane;
  const win = getWindow(_state);

  if (!currentTabId) {
    return null;
  }

  return win?.tabs[currentTabId] || null;
};

// called by server for each window in workspace after deleting project
// from the db
export const removeProjectFromColab = (projectId: string) => {
  setState(
    produce((_state: AppState) => {
      const _project = _state.projects[projectId];
      Object.keys(_state.fileCache).forEach((path) => {
        if (path.startsWith(_project.path)) {
          console.log("deleting path");
          delete _state.fileCache[path];
        }
      });

      delete _state.projects[projectId];
      // todo (yoav): close open tabs that belong to the project

      _state.settingsPane = { type: "", data: {} };
    })
  );
};

// Sometimes when modifying a hierarchical tree you need to
// find the parent of an object to swap it out. In complex trees
// you also need to get the key name of this descendant and potentially the
// index and other info. This function
// keeps the object reference but removes all the keys and then
// sets new key/values on it so you don't need to know anything about the parent.
// Since this mutates the original object reference it should
// be used inside a solid.js/immer produce block
export const reshapeObjectReference = <T extends Record<string, any>>(
  objectReference: Record<string, unknown>,
  newProps: T
): T => {
  Object.keys(objectReference).forEach((key) => delete objectReference[key]);
  Object.keys(newProps).forEach(
    (key) => (objectReference[key] = newProps[key])
  );
  return objectReference as T;
};

export const closeTab = (tabId: string) => {
  setState(
    produce((_state: AppState) => {
      const win = getWindow(_state);

      if (!win) {
        return;
      }

      const tab = win.tabs[tabId];
      
      // If this is a terminal tab, kill the terminal process
      if (tab.type === "terminal" && tab.terminalId) {
        electrobun.rpc?.request.killTerminal({
          terminalId: tab.terminalId,
        });
      }
      
      const pane = getPaneWithId(_state, tab.paneId);
      if (pane?.type !== "pane") {
        return;
      }
      const index = pane.tabIds.indexOf(tabId);
      pane.tabIds = pane.tabIds.filter((id) => id !== tabId);

      if (pane.currentTabId === tabId) {
        const newCurrentTabIndex = Math.max(
          0,
          Math.min(index, pane.tabIds.length - 1)
        );
        pane.currentTabId = pane.tabIds[newCurrentTabIndex] || "";
      }

      delete win.tabs[tabId];
    })
  );
  updateSyncedState();
};

export const getPane = (_state: AppState, pathToPane: PanePathType) => {
  let pane = getRootPane(_state);

  for (let i = 0; i < pathToPane.length; i++) {
    if (pane && "panes" in pane && pane.panes) {
      pane = pane?.panes[pathToPane[i]];
    }
  }

  return pane;
};

export const splitPane = (
  pathToPane: PanePathType,
  direction: "row" | "column",
  cloneTab = false,
  fromCenter = false
) => {
  setState(
    produce((_state: AppState) => {
      const win = getWindow(_state);
      if (!win) {
        return;
      }

      const rightChildPaneId = getUniqueId();
      const rightChildPane = {
        id: rightChildPaneId,
        type: "pane",
        tabIds: [],
        // todo (yoav): [blocker] should this be currentTabIndex
        // otherwise can end up with a currentTabId that isn't in the tab array
        // this causes the tab content to show up in the pane but not the tab bar
        // so there's no way to close it
        currentTabId: null,
      } as LayoutPaneType;

      // could be a pane or container that will be converted to the new parent container
      const paneToSplit = getPane(_state, pathToPane);
      if (!paneToSplit) {
        return;
      }
      // console.log("a: pathToPane", pathToPane, convertedContainer);
      const originalType = paneToSplit.type;

      const leftChildPane =
        originalType === "pane"
          ? ({
              id: paneToSplit.id,
              type: "pane",
              tabIds: [...paneToSplit.tabIds],
              currentTabId: paneToSplit.currentTabId,
            } as LayoutPaneType)
          : ({
              id: paneToSplit.id,
              type: "container",
              panes: [...paneToSplit.panes],
              divider: paneToSplit.divider,
              direction: paneToSplit.direction,
            } as LayoutContainerType);

      const convertedContainer = reshapeObjectReference<LayoutContainerType>(
        paneToSplit,
        {
          id: getUniqueId(),
          type: "container",
          direction,
          divider: 50,
          panes:
            originalType === "pane" && !fromCenter
              ? [leftChildPane, rightChildPane]
              : [rightChildPane, leftChildPane],
        }
      );

      win.currentPaneId = rightChildPaneId;

      if (leftChildPane.type === "pane" && cloneTab) {
        const tabToClone = leftChildPane.currentTabId
          ? win.tabs[leftChildPane.currentTabId]
          : null;

        if (tabToClone) {
          const clonedTabId = getUniqueId();

          const clonedTab = {
            ...unwrap(tabToClone),
            id: clonedTabId,
            isPreview: false,
            paneId: rightChildPaneId,
          };

          win.tabs[clonedTabId] = clonedTab;

          rightChildPane.tabIds.push(clonedTabId);
          rightChildPane.currentTabId = clonedTabId;
        }
      }
    })
  );
  // updateSyncedState();
};

export const getEditorForTab = (tabId: string) => {
  const editors = state.editors;

  for (const editorId in editors) {
    if (editors[editorId].tabId === tabId) {
      return editors[editorId];
    }
  }
};

// todo: move this to a file util

// Note: ui sends request to server, which then fires a filewatch event
// export const fullyDeleteNode = (path: string) => {
//   if (!path) {
//     return;
//   }
//   // todo (yoav): [blocking] maybe the settings pane should close itself when the node is deleted
//   // it also needs to refresh if the file changes outside of Colab
//   if (
//     "node" in state.settingsPane.data &&
//     state.settingsPane.data.node.path === path
//   ) {
//     setState("settingsPane", { type: "", data: {} });
//   }
//   console.log("fullyDeleteNode", path);
//   // todo (yoav): [blocking] add a confirmation dialog
//   safeTrashFileOrFolder(path);

//   // todo (yoav): we need to update Colab file when removing slates
//   // todo (yoav): add a "remove slate" button to the context menu
//   // todo (yoav): make slate settings reactive and save to .colab.json
// };

export const openFileAt = (path: string, line: number, column: number) => {
  const selection: monaco.IRange = {
    startLineNumber: line,
    startColumn: column,
    endLineNumber: line,
    endColumn: column,
  };

  const win = getWindow();
  if (!win) {
    return;
  }

  const tabArray = Object.values(win?.tabs);

  const currentTab = getCurrentTab();

  if (currentTab?.path === path) {
    const editor = getEditorForTab(currentTab.id)?.editor;
    // editor?.setPosition(selectionOrPosition);
    editor?.focus();
    editor?.setSelection(selection);
    editor?.revealLineInCenter(selection.startLineNumber);
    return;
  }

  const openTabsAtTargetPath = tabArray.filter((tab) => tab.path === path);

  const tabInCurrentPane = openTabsAtTargetPath.find(
    (tab) => tab.paneId === currentTab?.paneId
  );

  if (tabInCurrentPane) {
    focusTabWithId(tabInCurrentPane.id);

    const editor = getEditorForTab(tabInCurrentPane.id)?.editor;
    editor?.focus();
    editor?.setSelection(selection);
    editor?.revealLineInCenter(selection.startLineNumber);
    return;
  }

  if (openTabsAtTargetPath.length) {
    const firstTab = openTabsAtTargetPath[0];
    focusTabWithId(firstTab.id);
    const editor = getEditorForTab(firstTab.id)?.editor;
    editor?.focus();
    editor?.setSelection(selection);
    editor?.revealLineInCenter(selection.startLineNumber);

    return;
  }

  const newTabId = openNewTab({
    type: "file",
    path,
    selection, // Pass selection to be applied when editor loads
  } as any);

  // Try to apply selection if editor is ready, but it will be applied
  // by the CodeEditor component when it mounts if editor isn't ready yet
  const editor = getEditorForTab(newTabId)?.editor;
  if (editor) {
    editor.focus();
    editor.setSelection(selection);
    editor.revealLineInCenter(selection.startLineNumber);
  }
};

// Functions for managing non-project open files
export const addOpenFile = (absolutePath: string, name: string, type: 'file' | 'dir') => {
  setState(
    produce((_state: AppState) => {
      _state.openFiles[absolutePath] = {
        name,
        type,
        addedAt: Date.now(),
      };
    })
  );
};

export const removeOpenFile = (absolutePath: string) => {
  setState(
    produce((_state: AppState) => {
      delete _state.openFiles[absolutePath];
    })
  );
};

export const isFileInProject = (absolutePath: string): boolean => {
  const projects = state.projects;
  for (const project of Object.values(projects)) {
    if (absolutePath.startsWith(project.path + '/') || absolutePath === project.path) {
      return true;
    }
  }
  return false;
};
