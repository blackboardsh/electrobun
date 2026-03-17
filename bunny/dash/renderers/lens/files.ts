// XXX
// import { spawn } from "child_process";
import { createEffect, untrack } from "solid-js";
import { type AppState, setState, state } from "./store";
import { join, relative } from "../utils/pathUtils";
import {
  type PreviewFileTreeType,
  type ProjectType,
  type SlateType,
  type CachedFileType,
  type FolderNodeType,
} from "../../shared/types/types";
import { electrobun } from "./init";

// const HOME_DIRECTORY = homedir();
// const COLAB_DIRECTORY = join(HOME_DIRECTORY, "colab");
// export const DEFAULT_CODE_DIRECTORY = join(HOME_DIRECTORY, "colab");

// todo (yoav): [blocking] move this to store
// export interface FileNodeType {
//   name: string;
//   path: string;
//   type: "file";
//   contents: string;
//   isDirty: boolean;
//   model: any;
// }

// export interface PreviewFolderNodeType<Extended> {
//   name: string;
//   path: string;
//   type: "dir";
//   children: Record<string, FileTreeType<Extended>>;
// }

// export type FileTreeType<Extended = {}> = CachedFileType | PreviewFolderNodeType<Extended> & Extended;

// XXX
// import "./files";
// this import was imported into index.tsx and just doing this
// this should happen on the server, maybe i fetch Projects and send

// // createEffect(() => {
//   const { projects } = state;
//   if (projects) {
//     createFoldersForProjects(projects);
//   }
// });
// export const createFoldersForProjects = (projectsById: AppState['projects']) => {
//   if (!state.paths?.COLAB_HOME_FOLDER) {
//     throw new Error('Must set COLAB_HOME_FOLDER in state.paths')
//   }
//   for (const projectId in projectsById) {
//     const project = projectsById[projectId];
//     // TODO: connect this to branch changes later
//     const projectPath = join(state.paths.COLAB_HOME_FOLDER, makeFileNameSafe(project.name));
//     if (!existsSync(projectPath)) {
//       mkdirSync(projectPath, { recursive: true });
//     }
//   }
// };

// todo (yoav): [blocking] move this to a store and make it reactive when state changes (wtf did I mean by this comment)
// todo (yoav): [blocking] rename this to writeColabSlateConfigFile since it's different to writing a package.json config file
export const writeSlateConfigFile = (
  absoluteFolderPath: string,
  slate: SlateType
) => {
  // Projects are stored in GoldfishDB, not .colab.json
  // Only write .colab.json for web and agent slates
  if (slate.type === "web" || slate.type === "agent") {
    const configPath = join(absoluteFolderPath, ".colab.json");

    let contents;
    if (slate.type === "agent") {
      contents = JSON.stringify({
        v: 1,
        name: slate.name || "",
        type: slate.type || "",
        icon: slate.icon || "",
        config: slate.config || {},
      });
    } else {
      // web type
      contents = JSON.stringify({
        v: 1,
        name: slate.name || "",
        type: slate.type || "",
        url: slate.url || "",
        icon: slate.icon || "",
        config: slate.config || {},
      });
    }

    // save your file here
    const result = electrobun.rpc?.request.writeFile({
      path: configPath,
      value: contents,
    });

    // todo: handle failure
    // if (!result?.success) {
    //   // todo: handle failed write
    //   return;
    // }
  }
};

export const getProjectForNode = (
  node: PreviewFileTreeType,
  _state: AppState = state
) => {
  if (!node) {
    return null;
  }
  return getProjectForNodePath(node.path, _state);
};

// Check if a node is the root of a project (its path exactly matches a project path)
export const isProjectRoot = (
  node: PreviewFileTreeType | CachedFileType | null | undefined,
  _state: AppState = state
) => {
  if (!node) {
    return false;
  }
  return Object.values(_state.projects).some(
    (project) => project.path && project.path === node.path
  );
};

// Get the project that has this node as its root (exact match, not descendant)
export const getProjectByRootPath = (
  nodePath: string,
  _state: AppState = state
) => {
  return Object.values(_state.projects).find(
    (project) => project.path && project.path === nodePath
  );
};

export const getProjectForNodePath = (
  nodePath: string,
  _state: AppState = state
) => {
  // Find all projects that contain this path
  const matchingProjects = Object.values(_state.projects).filter((project) => {
    // Skip projects with empty or invalid paths
    if (!project.path) {
      return false;
    }
    return nodePath.startsWith(project.path);
  });

  if (matchingProjects.length === 0) {
    return undefined;
  }

  // Return the most specific (deepest nested) project
  // This ensures files in nested projects are associated with the child project, not the parent
  return matchingProjects.reduce((deepest, current) => {
    return current.path.length > deepest.path.length ? current : deepest;
  });
};

export const getFileTreesChildPathToNode = (nodePath: string): string[] => {
  return untrack(() => {
    const project = getProjectForNodePath(nodePath);

    if (!project?.path) {
      // todo (yoav): [blocking] can remove after cleaning up the old bad data
      return [];
    }

    const location = ["fileTrees", project.id];

    const relativePath = relative(project.path, nodePath);
    const relativePathParts = relativePath.split("/").filter(Boolean);
    for (const part of relativePathParts) {
      location.push("children");
      location.push(part);
    }
    return location;
  });
};

// given something nodeShaped, return the copy from state
// todo (yoav): rename this function

const fileSlates = {
  ".git": {
    name: "Open GIT Tab",
    type: "git",
    icon: "", //"https://git-scm.com/images/logos/downloads/Git-Icon-1788C.png",
    // TODO: default git config here
    config: {},
  },
  "package.json": {
    name: "Npm (package.json)",
    type: "npm",
    icon: "",
    config: {},
  },
  // Note: .webflowrc.json and webflow.json are now handled by the webflow-plugin
  // via the plugin slate system (see pluginSlateRegistry.tsx)
};

// Template slates - cached to maintain object reference for reactivity
const templateSlates = {
  browserChromium: {
    v: 1,
    name: "Chromium Tab",
    type: "web" as const,
    url: "https://blackboard.sh",
    icon: "views://assets/file-icons/chrome-logo.svg",
    config: {
      renderer: "cef" as const,
    },
  },
  browserWebKit: {
    v: 1,
    name: "WebKit Tab",
    type: "web" as const,
    url: "https://blackboard.sh",
    icon: "views://assets/file-icons/webkit-logo.svg",
    config: {
      renderer: "system" as const,
    },
  },
  agent: {
    v: 1,
    name: "AI Chat",
    type: "agent" as const,
    icon: "views://assets/file-icons/agent.svg",
    config: {},
  },
};

// todo: - how much of this should be async via the backend vs. completely stored, and cached
// on the backend.
export const getSlateForNode = (
  node?: CachedFileType | PreviewFileTreeType | null
) => {
  if (!node) {
    // throw new Error('Must give a node')
    return undefined;
  }

  // Note: In certain siutations, like creating a node we're looking
  // at a previewnode which just has the slate defined on it
  if ("slate" in node) {
    return node.slate;
  }

  // Guard against nodes with undefined path
  if (!node.path) {
    return undefined;
  }

  if (node.path.startsWith("__COLAB_INTERNAL__")) {
    if (node.path === "__COLAB_INTERNAL__/web") {
      return {
        v: 1,
        name: "Web",
        type: "web",
        url: "https://colab.dev",
        icon: "",
        config: {},
      };
    }
    return;
  }

  // Handle template nodes
  if (node.path.startsWith("__COLAB_TEMPLATE__")) {
    // Extract template type from path (handles unique IDs like browser-chromium/abc123)
    const pathParts = node.path.replace("__COLAB_TEMPLATE__/", "").split("/");
    const templateType = pathParts[0]; // e.g., "browser-chromium" or "browser-webkit"

    if (templateType === "browser-chromium") {
      return templateSlates.browserChromium;
    }
    if (templateType === "browser-webkit") {
      return templateSlates.browserWebKit;
    }
    if (templateType === "browser") {
      // Legacy browser template - default to Chromium
      return templateSlates.browserChromium;
    }
    if (templateType === "terminal") {
      // Terminal tabs are handled differently - they don't use slates
      return undefined;
    }
    if (templateType === "agent") {
      return templateSlates.agent;
    }
    return;
  }

  const fileOrFolderName = node.path.split("/").pop();

  if (fileOrFolderName && fileOrFolderName in fileSlates) {
    const fileNameSlate =
      fileSlates[fileOrFolderName as keyof typeof fileSlates];

    if (fileNameSlate) {
      // For .git, create a custom slate with the parent folder name
      if (fileOrFolderName === ".git") {
        const parentFolderName = node.path.split("/").slice(-2, -1)[0] || "Git";
        return {
          ...fileNameSlate,
          name: `Git: ${parentFolderName}`,
        };
      }
      return fileNameSlate;
    }
  }

  if (node.type === "dir") {
    const colabConfigFile = (node as FolderNodeType).children?.includes(
      ".colab.json"
    );

    if (colabConfigFile) {
      const absoluteColabConfigPath = join(node.path, ".colab.json");
      const cachedConfig = state.slateCache[absoluteColabConfigPath];

      if (cachedConfig) {
        // Skip project slates from .colab.json - projects are now stored in GoldfishDB
        // and detected via isProjectRoot()
        if (cachedConfig.type === "project") {
          return undefined;
        }
        return cachedConfig;
      }

      // Note: readSlateConfigFile is async, so we can't filter here.
      // Project slates will be filtered when they're read from cache next time.
      return readSlateConfigFile(absoluteColabConfigPath);
    }

    // Note: currently .colab.json is the only nested slate type, but in the future
    // you could add more here
  }

  // Check for plugin slates (e.g., webflow.json, .webflowrc.json)
  // Use inline check since findPluginSlateForFile is defined later in the file
  if (node.type === "file" && node.path) {
    const pluginSlates = state.pluginSlates;
    if (pluginSlates && pluginSlates.length > 0) {
      const filename = node.path.split("/").pop() || "";
      for (const slate of pluginSlates) {
        if (slate.folderHandler) continue;
        for (const pattern of slate.patterns) {
          if (pattern === filename || (pattern.startsWith("*.") && filename.endsWith(pattern.slice(1)))) {
            // Return a slate-like object so the context menu knows this file has a slate
            return {
              v: 1,
              name: slate.name,
              type: "plugin" as const,
              icon: slate.icon || "",
              pluginSlateId: slate.id,
              pluginName: slate.pluginName,
            };
          }
        }
      }
    }
  }

  // return node.type;
};

// Note: this can be used to read and cache any slate config file .colab.json, package.json, etc.
// currently only supports json files
export const readSlateConfigFile = (path: string, cacheResult = true) => {
  electrobun.rpc?.request.readSlateConfigFile({ path }).then((slate) => {
    if (slate && cacheResult) {
      setState("slateCache", path, slate);
    }
    return slate;
  });

  return null;
};

export const isDescendantPath = (parentPath: string, childPath: string) => {
  const relativePath = relative(parentPath, childPath);
  return relativePath && !relativePath.startsWith("..");
};

// ============================================================================
// Plugin Slate Support
// ============================================================================

export interface PluginSlateInfo {
  id: string;
  pluginName: string;
  name: string;
  description?: string;
  icon?: string;
  patterns: string[];
  folderHandler?: boolean;
}

/**
 * Fetch plugin slates from backend and store them in reactive state.
 * Also initializes plugin renderer components for the loaded plugins.
 * Call this early during app initialization.
 */
export const loadPluginSlates = async (): Promise<void> => {
  try {
    const slates = await electrobun.rpc?.request.pluginGetAllSlates();
    setState("pluginSlates", slates || []);

    // Initialize renderer components for all plugins that have slates
    const { initializeAllPluginRenderers } = await import("./slates/pluginSlateRegistry");
    if (slates && slates.length > 0) {
      const pluginNames = [...new Set(slates.map((s: PluginSlateInfo) => s.pluginName))];
      await initializeAllPluginRenderers(pluginNames);
    } else {
      // Even with no slates, mark renderers as ready
      await initializeAllPluginRenderers([]);
    }
  } catch (e) {
    console.error("[files] Failed to load plugin slates:", e);
    setState("pluginSlates", []);
    // Mark renderers ready even on error so slates don't hang
    const { initializeAllPluginRenderers } = await import("./slates/pluginSlateRegistry");
    await initializeAllPluginRenderers([]);
  }
};

/**
 * Get all cached plugin slates (from reactive store)
 */
export const getPluginSlates = (): PluginSlateInfo[] => {
  return state.pluginSlates;
};

/**
 * Find a plugin slate that matches a file path.
 * Uses the reactive store so UI will update when plugin slates are loaded.
 * Returns null if no plugin slate matches (use built-in slates instead)
 */
export const findPluginSlateForFile = (filePath: string): PluginSlateInfo | null => {
  const pluginSlates = state.pluginSlates;

  // If plugin slates haven't been loaded yet, return null
  // The UI will re-evaluate when pluginSlates is populated
  if (!pluginSlates || pluginSlates.length === 0) {
    return null;
  }

  const filename = filePath.split("/").pop() || "";

  for (const slate of pluginSlates) {
    // Skip folder handlers when looking for files
    if (slate.folderHandler) continue;

    for (const pattern of slate.patterns) {
      // Exact match
      if (pattern === filename) {
        return slate;
      }

      // Handle simple wildcard patterns (*.webflowrc.json)
      if (pattern.startsWith("*.")) {
        const suffix = pattern.slice(1);
        if (filename.endsWith(suffix)) {
          return slate;
        }
      }

      // Handle **/ prefix (matches any directory depth)
      if (pattern.startsWith("**/")) {
        const restPattern = pattern.slice(3);
        if (filename === restPattern || filePath.endsWith("/" + restPattern)) {
          return slate;
        }
      }
    }
  }

  return null;
};

/**
 * Find a plugin slate that matches a folder path
 * This is for folder handler slates (like devlink which handles folders with .webflowrc.json)
 */
export const findPluginSlateForFolder = async (folderPath: string): Promise<PluginSlateInfo | null> => {
  try {
    const result = await electrobun.rpc?.request.pluginFindSlateForFolder({ folderPath });
    return result || null;
  } catch (e) {
    console.error("[files] Failed to find plugin slate for folder:", e);
    return null;
  }
};

/**
 * Refresh the plugin slates cache
 * Call this after plugin installation/uninstallation
 */
export const refreshPluginSlates = async (): Promise<void> => {
  await loadPluginSlates();
};
