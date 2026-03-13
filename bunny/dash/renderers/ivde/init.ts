import { Electroview } from "electrobun/view";
import { type WorkspaceRPC } from "./rpc";
import {
  type CachedFileType,
  type ProjectType,
  type PreviewFolderNodeType,
} from "../../shared/types/types";
import {
  state,
  setState,
  getWindow,
  type AppState,
  focusTabWithId,
  openNewTabForNode,
  openNewTab,
  editNodeSettings,
  removeProjectFromColab,
  splitPane,
  openNewTerminalTab,
  setNodeExpanded,
  closeTab,
  getCurrentTab,
  getPaneWithId,
} from "./store";
import { produce, reconcile } from "solid-js/store";
import { join, basename, dirname } from "../utils/pathUtils";
import { _getNode, getNode } from "./FileWatcher";
import { trackFrontend } from "./analytics";
import {untrack} from "solid-js";
import { loadPluginSlates } from "./files";
import { initializeSlateRegistry } from "./slates/pluginSlateRegistry";
import { registerColabTerminal } from "../components/ColabTerminal";
// import { readSlateConfigFile } from "./files";

// Initialize the slate component registry early
initializeSlateRegistry();

// Register web components for plugins to use
registerColabTerminal();

const rpc = Electroview.defineRPC<WorkspaceRPC>({
  maxRequestTime: 60 * 1000,
  handlers: {
    requests: {},
    messages: {
      // "*": (messageName, payload) => {
      //   console.log("bun onmessage", messageName, payload);
      // },
      initState: ({ windowId, buildVars, paths, peerDependencies }) => {
        setState({ windowId, buildVars, paths, peerDependencies });
      },
      updateStatus: (data) => {
        setState("update", data);
      },
      setProjects: ({ projects, tokens, workspace, appSettings }) => {
        // TODO: [blocking] make this a util, maybe in goldfish
        console.log("setProjects", { projects, tokens, workspace, appSettings });
        const projectsById = projects?.reduce(
          (acc: Record<string, ProjectType>, project: ProjectType) => {
            acc[project.id] = project;
            // buildFileTree(project.path, true)
            return acc;
          },
          {}
        );

        // todo (yoav): [blocking] if we used a flatmap tree
        // then we wouldn't need to rebuild the whole tree
        // for open tabs, we could just create a node
        // for the tab directly if the file exists

        // todo (yoav): [blocking] make this a util and core part of colab
        // todo (yoav): [blocking] what stuff is actually synced with the server and what is just local to the window and ephemeral

        setState(
          reconcile({
            ...state,
            workspace,

            projects: projectsById,
            tokens,
            // Merge appSettings from database with existing defaults
            appSettings: appSettings ? { ...state.appSettings, ...appSettings } : state.appSettings,
            // Note: we need the fileTrees to exist when this
            // setState gets triggered, since the presence of projects
            // and tabs and such will trigger rendering a bunch of stuff
            // fileTrees: fileTreesByProjectId,
          })
        );

        console.log("projects", state.projects);
      },
      fileWatchEvent: async ({
        absolutePath,
        exists,
        isDelete,
        isAdding,
        isFile,
        isDir,
      }) => {
        const stateFile = state.fileCache[absolutePath];
        // Force reactivity by resetting then setting (ensures change even for same file)
        setState("lastFileChange", null);
        setState("lastFileChange", absolutePath);

        if (!stateFile && !isAdding) {
          // if the file isn't in the cache then there's nothing to update
          return;
        }
        if (isDelete) {
          // destroy open tabs
          if (stateFile?.type === "file") {
            setState(
              produce((_state: AppState) => {
                const win = getWindow(_state);
                if (!win) {
                  return;
                }
                // todo (yoav): add utils for this.
                // there's no way to delete the key using setState without using produce or
                // spreading a new object or something
                if (_state.fileCache?.[absolutePath]) {
                  delete _state.fileCache[absolutePath];
                }

                const tabs = win.tabs;
                for (const tabId in tabs) {
                  const tab = tabs[tabId];
                  if (tab.path === absolutePath) {
                    // We do this so user can show a message that the file was deleted
                    // If the user was working in a tab and the file was deleted/rename/moved
                    // from outside of Colab
                    tab.path = "";
                  }
                }
              })
            );
            // file was removed, delete the model
            const currentFileModel = stateFile.model;
            // TODO: mark any open tabs as dirty
            currentFileModel?.dispose();
            // TODO: need to explore what happens to open tabs before adding more logic here
          }

          const slateConfig = state.slateCache[absolutePath];

          if (slateConfig) {
            setState(
              produce((_state) => {
                if (_state.slateCache?.[absolutePath]) {
                  delete _state.slateCache[absolutePath];
                }
              })
            );
          }

          // remove the file or folder from the cache
          setState(
            produce((_state: AppState) => {
              delete _state.fileCache[absolutePath];

              const filename = basename(absolutePath);
              const parentPath = dirname(absolutePath);
              const parent = _state.fileCache[parentPath];
              if (parent?.type === "dir") {
                parent.children = parent.children?.filter(
                  (childName: string) => childName !== filename
                );
              }
            })
          );
        } else {
          // this will fetch and cache it if it's not already cached
          const node = getNode(absolutePath);
          const filename = basename(absolutePath);
          const parentPath = dirname(absolutePath);
          const parent = _getNode(parentPath);

          if (parent) {
            // events may come in out of order
            if (parent.type === "dir") {
              if (!parent.children.includes(filename)) {
                const newChildren = [...parent.children, filename];
                setState("fileCache", parentPath, { children: newChildren });
              }
            }
          }

          // update the monaco model with the new/updated contents
          if (isFile) {
            if (stateFile?.type === "file" && stateFile.isCached) {
              // Only fetch file contents if the file has been explicitly loaded by the user
              const currentContents =
                stateFile.model?.getValue() || stateFile.persistedContent;
              const response = await electrobun.rpc?.request.readFile({
                path: absolutePath,
              });

              if (!response) {
                console.error('No response from readFile for:', absolutePath);
                return;
              }

              const { textContent: newContents, isBinary, loadedBytes, totalBytes } = response;

              console.log('Got file ', filename, ' with length: ', newContents?.length, 'isBinary:', isBinary);

              // Handle binary files
              if (isBinary) {
                console.log('File is binary, not updating editors:', absolutePath);
                setState("fileCache", absolutePath, {
                  isBinary: true,
                  totalBytes: totalBytes,
                });
                return;
              }

              if (currentContents !== newContents) {
                // Note: model.setValue() wipes out undo/redo history. to preserve it we need to do an edit operation instead
                // basically select everything and replace with the new contents
                // todo (yoav): save and retrive editor from CodeEditor on state.files[path].editors[editorId] we need to just update all the editors
                // todo (yoav): need to start with a single editor per tab
                const editors = stateFile.editors;
                for (const key in editors) {
                  const editor = editors[key];

                  editor.executeEdits("file-watcher", [
                    {
                      range: stateFile.model.getFullModelRange(),
                      text: newContents,
                    },
                  ]);
                }

                // file.model.setValue(newContents);

                setState("fileCache", absolutePath, {
                  persistedContent: newContents,
                  isDirty: false,
                  loadedBytes: loadedBytes,
                  totalBytes: totalBytes,
                });
              }
            }

            const slateConfig = state.slateCache[absolutePath];
            if (slateConfig) {
              // todo: should it update the config here??
              // const updatedConfig = readSlateConfigFile(absolutePath);
              // setState("slateCache", absolutePath, updatedConfig);
            }
          } else if (isDir) {
            // rebuild the file tree
          }
        }
      },
      tsServerMessage: ({ message, metadata }) => {
        const handler = state.editors[metadata.editorId].handleTsServerResponse;

        if (handler) {
          handler(message);
        }
      },
      focusTab: ({ tabId }) => {
        focusTabWithId(tabId);
      },
      openNewTab: ({ nodePath }) => {
        openNewTabForNode(nodePath, false, { focusNewTab: false });
      },
      openAsText: ({ nodePath }) => {
        // Open file directly in code editor, bypassing any slate
        openNewTab({
          type: "file",
          path: nodePath,
          forceEditor: true,
        }, false);
      },
      openUrlInNewTab: ({url}) => {
        console.log('openUrlInNewTab', url)
        openNewTabForNode(`__COLAB_INTERNAL__/web`, false, { focusNewTab: false, url });
      },
      showNodeSettings: ({ nodePath }) => {
        const node = getNode(nodePath);
        if (!node) {
          return;
        }
        editNodeSettings(node);
      },
      addChildNode: async ({ nodePath, nodeType }) => {
        console.log("addChildNode called with:", { nodePath, nodeType });
        const node = getNode(nodePath);
        if (!node) {
          console.log("Node not found:", nodePath);
          return;
        }

        // Always open settings panel to allow name editing
        const actualNodeType = nodeType || "file";
        const baseName = actualNodeType === "dir" ? "new-folder" : 
                         actualNodeType === "repo" ? "new-repo" : "new-file";

        // clear settings and then set after a delay for animation to play
        // and to cleanly reset the add node settings
        const delay = untrack(() => {
          return state.settingsPane.type ? 400 : 0;
        })

        setState("settingsPane", {
          type: "",
          data: {}
        })        
        setTimeout(async () => {
          const nodeName = await electrobun.rpc?.request.getUniqueNewName({
            parentPath: node.path,
            baseName,
          });
          
          const childNode: CachedFileType | PreviewFolderNodeType = actualNodeType === "repo" ? {
            type: "dir",
            name: nodeName,
            path: join(node.path, nodeName),
            isExpanded: true,
            previewChildren: [],
            slate: {
              v: 1,
              name: nodeName,
              type: "repo",
              icon: "🔀",
              config: {
                gitUrl: "",
                branch: "main",
              },
            },
          } : {
            type: actualNodeType === "dir" ? "dir" : "file",
            name: nodeName,
            path: join(node.path, nodeName),
            persistedContent: "",
            model: null,
            isDirty: false,
            editors: {},
          };
        
          setState("settingsPane", {
            type: "add-node",
            data: {
              node: childNode,
              previewNode: childNode,
              selectedNodeType: actualNodeType, // Pass the intended node type to settings
            },
          });
        }, delay)
        
      },
      newTerminal: ({ nodePath }) => {        
        const node = getNode(nodePath);
        if (!node) {
          return;
        }
        openNewTerminalTab(node.path);
      },
      deleteProject: ({ projectId }) => {
        console.log("removeProjectFromColab", projectId);
        removeProjectFromColab(projectId);
      },

      splitPaneContainer: ({ pathToPane, direction }) => {
        splitPane(pathToPane, direction, false, true);
      },
      findAllInFolderResult: ({ query, projectId, results }) => {
        // There's a small race condition so we send the query with the results
        // and discard results for stale queries
        if (query !== state.findAllInFolder.query) {
          return;
        }

        setState(
          produce((_state: AppState) => {
            const _findAllResults = _state.findAllInFolder.results;
            if (!_findAllResults[projectId]) {
              _findAllResults[projectId] = {};
            }

            const _findAllResultsForProject = _findAllResults[projectId];

            results.forEach((result) => {
              const { path, line, column, match } = result;
              if (!_findAllResultsForProject[path]) {
                _findAllResultsForProject[path] = [];
              }
              _findAllResultsForProject[path].push({
                line,
                column,
                match,
              });
            });
          })
        );
      },
      findFilesInWorkspaceResult: ({ query, projectId, results }) => {
        // Ignore stale results - only process if query matches current query
        if (query !== state.commandPalette.query) {
          return;
        }

        setState(
          produce((_state: AppState) => {
            const _findFileResults = _state.commandPalette.results;
            if (!_findFileResults[projectId]) {
              _findFileResults[projectId] = [];
            }

            results.forEach((result) => {
              _findFileResults[projectId].push(result);
            });
          })
        );
      },
      openCommandPalette: () => {
        trackFrontend("commandPaletteOpen", {
          fromShortcut: true,
        });
        setState("ui", "showCommandPalette", !state.ui.showCommandPalette);
      },
      newBrowserTab: () => {
        // console.log("[DEBUG] newBrowserTab handler called", new Error().stack);
        // return;
        const uniqueId = Math.random().toString(36).substring(2, 11);
        openNewTabForNode(`__COLAB_TEMPLATE__/browser-chromium/${uniqueId}`, false, {
          focusNewTab: true,
        });
      },
      closeCurrentTab: () => {
        const currentTab = getCurrentTab();
        if (currentTab) {
          closeTab(currentTab.id);
        }

        // If after closing the tab we no longer have a current tab,
        // focus the next available tab
        const win = getWindow();
        if (!win) return;

        const currentPane = getPaneWithId(state, win.currentPaneId);
        if (currentPane?.type !== "pane") return;

        if (!currentPane?.currentTabId) {
          const tabArray = Object.values(win.tabs);
          if (tabArray.length) {
            const nextTab = tabArray[tabArray.length - 1];
            focusTabWithId(nextTab.id);
          }
        }
      },
      closeCurrentWindow: () => {
        const win = getWindow();
        const tabCount = Object.keys(win?.tabs || {}).length;
        if (tabCount > 0) {
          // Dispatch event to show close window confirmation dialog
          window.dispatchEvent(new CustomEvent('showCloseWindowDialog'));
        } else {
          electrobun.rpc?.send.closeWindow();
        }
      },
      handleGlobalShortcut: ({ key, ctrl, shift, alt, meta }) => {
        // Dispatch a synthetic keyboard event to trigger the existing shortcut handlers
        const event = new KeyboardEvent('keydown', {
          key,
          ctrlKey: ctrl,
          shiftKey: shift,
          altKey: alt,
          metaKey: meta,
          bubbles: true,
          cancelable: true,
        });
        document.dispatchEvent(event);
      },
      openSettings: ({ settingsType }) => {
        setState("settingsPane", { type: settingsType, data: {} });
      },
      terminalOutput: (data: { terminalId: string; data: string }) => {
        // Notify all terminal components about new output
        window.dispatchEvent(new CustomEvent('terminalOutput', { detail: data }));
      },
      terminalExit: (data: { terminalId: string; exitCode: number }) => {
        // Notify all terminal components about terminal exit
        window.dispatchEvent(new CustomEvent('terminalExit', { detail: data }));
      },
      openFileInEditor: (data: { filePath: string; createIfNotExists?: boolean }) => {
        // Open a file in the editor (from edit command, Open menu, or drag-drop)
        window.dispatchEvent(new CustomEvent('openFileInEditor', { detail: data }));
      },
      openFolderAsProject: (data: { folderPath: string }) => {
        // Add a folder as a project
        window.dispatchEvent(new CustomEvent('openFolderAsProject', { detail: data }));
      },
      removeOpenFile: (data: { filePath: string }) => {
        // Remove a file from the open files list
        window.dispatchEvent(new CustomEvent('removeOpenFile', { detail: data }));
      },
      downloadStarted: (data: { filename: string; path: string }) => {
        setState("downloadNotification", {
          visible: true,
          filename: data.filename,
          path: data.path,
          status: 'downloading',
          progress: 0,
        });
      },
      downloadProgress: (data: { progress: number }) => {
        // Only update progress if we're currently downloading
        const current = state.downloadNotification;
        if (current && current.status === 'downloading') {
          setState("downloadNotification", {
            ...current,
            progress: data.progress,
          });
        }
      },
      downloadCompleted: (data: { filename: string; path: string }) => {
        setState("downloadNotification", {
          visible: true,
          filename: data.filename,
          path: data.path,
          status: 'completed',
        });
        // Auto-hide after 5 seconds
        setTimeout(() => {
          setState("downloadNotification", null);
        }, 5000);
      },
      downloadFailed: (data: { filename: string; path: string; error: string }) => {
        setState("downloadNotification", {
          visible: true,
          filename: data.filename,
          path: data.path,
          status: 'failed',
          error: data.error,
        });
        // Auto-hide after 8 seconds
        setTimeout(() => {
          setState("downloadNotification", null);
        }, 8000);
      },
      slateRender: (data: { instanceId: string; html?: string; script?: string }) => {
        // Notify slate components about render updates from plugins
        window.dispatchEvent(new CustomEvent('slateRender', { detail: data }));
      },
      createSpecialFile: async ({ nodePath, fileType }) => {
        let fileName = "";
        let defaultContent = "";

        if (fileType === "preload") {
          fileName = ".preload.js";
          defaultContent = `// Preload script for this web browser profile
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
        } else if (fileType === "context") {
          fileName = ".context.md";
          defaultContent = `# Agent Context

This file contains custom context and instructions for your AI agent.

## Personality
You are a helpful assistant with the following characteristics:
- Be concise and direct
- Focus on practical solutions
- Ask clarifying questions when needed

## Special Instructions
- When writing code, always include comments
- Prefer modern JavaScript/TypeScript syntax
- Suggest best practices and alternatives

## Knowledge Areas
- Web development
- JavaScript/TypeScript
- Node.js
- React
- Backend development

## Response Style
- Use examples when explaining concepts
- Break down complex topics into steps
- Provide actionable advice

---
*Edit this file to customize your agent's behavior and knowledge.*
`;
        }

        const filePath = join(nodePath, fileName);

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

          // For preload files, expand the web node folder after creation and open the file
          if (fileType === "preload") {
            if (wasCreated) {
              // Wait a bit for the file system events to be processed and the file to be detected
              setTimeout(() => {
                // Expand the web node folder
                setNodeExpanded(nodePath, true);
              }, 500);
            } else {
              // File already exists, expand immediately
              setNodeExpanded(nodePath, true);
            }

            // Open the file in the current pane (not as a new tab, replace preview if needed)
            openNewTabForNode(filePath, false, { focusNewTab: true });
          } else {
            // For other file types, keep the existing behavior
            openNewTabForNode(filePath, false, { focusNewTab: true });
          }
        } catch (error) {
          console.error(`Error creating ${fileName}:`, error);
          alert(`Failed to create ${fileName}. Please try again.`);
        }
      },
      copyToClipboard: async ({ text }: { text: string }) => {
        try {
          await navigator.clipboard.writeText(text);
          console.log("Copied to clipboard:", text);
        } catch (error) {
          console.error("Failed to copy to clipboard:", error);
          // Fallback: show the text in an alert so user can manually copy
          alert(`Failed to copy automatically. Path:\n${text}`);
        }
      },
    },
  },
});

export const electrobun = new Electroview({ rpc });

// Expose electrobun on window for web components (like colab-terminal) to access
(window as any).electrobun = electrobun;
