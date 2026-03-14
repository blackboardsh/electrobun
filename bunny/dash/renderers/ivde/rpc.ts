import { type RPCSchema } from "electrobun/view";
import type {
  PreviewFileTreeType,
  ParsedResponseType,
  PanePathType,
  SlateType,
} from "../../shared/types/types";
import type { AppState } from "./store";
import type {
  CommitResult,
  DefaultLogFields,
  LogResult,
  Response,
  StatusResult,
} from "simple-git";
import type { WorkspaceType } from "./store";
import type { track } from "../../main/utils/analytics";

export type WorkspaceRPC = {
  // to bun
  bun: RPCSchema<{
    requests: {
      getInitialState: {
        params: void;
        response: any;
      };
      openLens: {
        params: {
          lensId: string;
        };
        response: any;
      };
      openLensInNewWindow: {
        params: {
          lensId: string;
        };
        response: any;
      };
      openWorkspace: {
        params: {
          workspaceId: string;
        };
        response: any;
      };
      openWorkspaceInNewWindow: {
        params: {
          workspaceId: string;
        };
        response: any;
      };
      overwriteCurrentLens: {
        params: void;
        response: any;
      };
      saveLens: {
        params: {
          name?: string;
          description?: string;
        };
        response: any;
      };
      showContextMenu: {
        params: {
          // todo: electrobun should expose menu items type
          menuItems: any[];
        };
      };
      newPreviewNode: {
        params: {
          candidateName: string;
        };
        response: PreviewFileTreeType;
      };
      addProject: {
        params: {
          projectName: string;
          path: string;
        };
        response: any;
      };
      getFaviconForUrl: {
        params: {
          url: string;
        };
        response: string;
      };
      copy: {
        params: {
          src: string;
          dest: string;
        };
        response: void;
      };
      gitShow: {
        params: {
          repoRoot: string;
          options: string[];
        };
        response: string;
      };
      gitCommit: {
        params: {
          repoRoot: string;
          msg: string;
        };
        response: CommitResult;
      };
      gitCommitAmend: {
        params: {
          repoRoot: string;
          msg: string;
        };
        response: CommitResult;
      };
      gitAdd: {
        params: {
          repoRoot: string;
          files: string | string[];
        };
        response: string;
      };
      gitLog: {
        params: {
          repoRoot: string;
          options: string[];
          limit?: number;
          skip?: number;
        };
        response: Response<LogResult<DefaultLogFields>> | { all: never[] };
      };
      gitStatus: {
        params: {
          repoRoot: string;
        };
        response: StatusResult;
      };
      gitDiff: {
        params: {
          repoRoot: string;
          options: string[];
        };
        response: string;
      };
      gitCheckout: {
        params: {
          repoRoot: string;
          hash: string;
        };
        response: string;
      };
      gitCheckIsRepoRoot: {
        params: {
          repoRoot: string;
        };
        response: boolean;
      };
      gitCheckIsRepoInTree: {
        params: {
          repoRoot: string;
        };
        response: boolean;
      };
      findFirstNestedGitRepo: {
        params: {
          searchPath: string;
          timeoutMs?: number;
        };
        response: string | null;
      };
      gitRevParse: {
        params: {
          repoRoot: string;
          options: string[];
        };
        response: string;
      };
      gitReset: {
        params: {
          repoRoot: string;
          options: string[];
        };
        response: string;
      };
      gitRevert: {
        params: {
          repoRoot: string;
          commitHash: string;
          options: string[];
        };
        response: string;
      };
      gitApply: {
        params: {
          repoRoot: string;
          options: string[];
          patch?: string;
        };
        response: string;
      };
      gitStageHunkFromPatch: {
        params: {
          repoRoot: string;
          patch: string;
        };
        response: string;
      };
      gitStageSpecificLines: {
        params: {
          repoRoot: string;
          filePath: string;
          startLine: number;
          endLine: number;
        };
        response: string;
      };
      gitStageMonacoChange: {
        params: {
          repoRoot: string;
          filePath: string;
          originalContent: string;
          targetChange: {
            originalStartLineNumber: number;
            originalEndLineNumber: number;
            modifiedStartLineNumber: number;
            modifiedEndLineNumber: number;
            charChanges?: Array<{
              originalStartLineNumber: number;
              originalStartColumn: number;
              originalEndLineNumber: number;
              originalEndColumn: number;
              modifiedStartLineNumber: number;
              modifiedStartColumn: number;
              modifiedEndLineNumber: number;
              modifiedEndColumn: number;
            }>;
          };
          modifiedContent: string;
        };
        response: string;
      };
      gitUnstageMonacoChange: {
        params: {
          repoRoot: string;
          filePath: string;
          originalContent: string;
          targetChange: {
            originalStartLineNumber: number;
            originalEndLineNumber: number;
            modifiedStartLineNumber: number;
            modifiedEndLineNumber: number;
          };
          stagedContent: string;
        };
        response: string;
      };
      gitCreatePatchFromLines: {
        params: {
          repoRoot: string;
          filePath: string;
          startLine: number;
          endLine: number;
        };
        response: string;
      };
      gitStashList: {
        params: {
          repoRoot: string;
        };
        response: any;
      };
      gitStashCreate: {
        params: {
          repoRoot: string;
          message?: string;
          options?: string[];
        };
        response: string;
      };
      gitStashApply: {
        params: {
          repoRoot: string;
          stashName: string;
        };
        response: string;
      };
      gitStashPop: {
        params: {
          repoRoot: string;
          stashName: string;
        };
        response: string;
      };
      gitStashShow: {
        params: {
          repoRoot: string;
          stashName: string;
        };
        response: string;
      };
      gitFetch: {
        params: {
          repoRoot: string;
          remote?: string;
          options?: string[];
        };
        response: string;
      };
      gitPull: {
        params: {
          repoRoot: string;
          remote?: string;
          branch?: string;
          options?: string[];
        };
        response: string;
      };
      gitPush: {
        params: {
          repoRoot: string;
          remote?: string;
          branch?: string;
          options?: string[];
        };
        response: string;
      };
      gitRemote: {
        params: {
          repoRoot: string;
        };
        response: any;
      };
      gitBranch: {
        params: {
          repoRoot: string;
          options?: string[];
        };
        response: any;
      };
      gitCheckoutBranch: {
        params: {
          repoRoot: string;
          branch: string;
          options?: string[];
        };
        response: string;
      };
      gitCreateBranch: {
        params: {
          repoRoot: string;
          branchName: string;
          options?: string[];
        };
        response: string;
      };
      gitDeleteBranch: {
        params: {
          repoRoot: string;
          branchName: string;
          options?: string[];
        };
        response: string;
      };
      gitTrackRemoteBranch: {
        params: {
          repoRoot: string;
          branchName: string;
          remoteName?: string;
        };
        response: string;
      };
      gitLogRemoteOnly: {
        params: {
          repoRoot: string;
          localBranch: string;
          remoteBranch: string;
        };
        response: { all: any[] };
      };
      gitClone: {
        params: {
          repoPath: string;
          gitUrl: string;
          createMainBranch?: boolean;
        };
        response: string;
      };
      gitValidateUrl: {
        params: {
          gitUrl: string;
        };
        response: {
          valid: boolean;
          error: string | null;
        };
      };
      getGitConfig: {
        params: void;
        response: {
          name: string;
          email: string;
          hasKeychainHelper: boolean;
        };
      };
      setGitConfig: {
        params: {
          name: string;
          email: string;
        };
        response: void;
      };
      checkGitHubCredentials: {
        params: void;
        response: {
          hasCredentials: boolean;
          username?: string;
        };
      };
      storeGitHubCredentials: {
        params: {
          username: string;
          token: string;
        };
        response: void;
      };
      removeGitHubCredentials: {
        params: void;
        response: void;
      };
      syncWorkspace: {
        params: {
          workspace: WorkspaceType;
        };
        response: void;
      };
      syncAppSettings: {
        params: {
          appSettings: AppState["appSettings"];
        };
        response: void;
      };
      openFileDialog: {
        params: {
          startingFolder: string;
          allowedFileTypes: string;
          canChooseFiles: boolean;
          canChooseDirectory: boolean;
          allowsMultipleSelection: boolean;
        };
        response: string[];
      };
      findAllInWorkspace: {
        params: {
          query: string;
        };
        response: {
          path: string;
          line: number;
          column: number;
          match: string;
        }[];
      };
      findFilesInWorkspace: {
        params: {
          query: string;
        };
        response: string[];
      };
      cancelFileSearch: {
        params: void;
        response: boolean;
      };
      cancelFindAll: {
        params: void;
        response: boolean;
      };
      getNode: {
        params: {
          path: string;
        };
        response:
          | {
              name: string;
              type: "dir";
              path: string;
              children: string[];
            }
          | {
              name: string;
              type: "file";
              path: string;
              persistedContent: "";
              isDirty: false;
              model: null;
              editors: {};
            }
          | null;
      };
      readSlateConfigFile: {
        params: {
          path: string;
        };
        response: SlateType | null;
      };
      readFile: {
        params: {
          path: string;
        };
        response: {
          textContent: string;
        };
      };
      writeFile: {
        params: {
          path: string;
          value: string;
        };
        response: {
          success: boolean;
          error?: string;
        };
      };
      touchFile: {
        params: {
          path: string;
          contents?: string;
        };
        response: {
          success: boolean;
          error?: string;
        };
      };
      rename: {
        params: {
          oldPath: string;
          newPath: string;
        };
        response: {
          success: boolean;
          error?: string;
        };
      };
      exists: {
        params: {
          path: string;
        };
        response: boolean;
      };
      showInFinder: {
        params: {
          path: string;
        };
        response: void;
      };
      mkdir: {
        params: {
          path: string;
        };
        response: {
          success: boolean;
          error?: string;
        };
      };
      isFolder: {
        params: {
          path: string;
        };
        response: boolean;
      };
      getUniqueNewName: {
        params: {
          parentPath: string;
          baseName: string;
        };
        response: string;
      };
      makeFileNameSafe: {
        params: {
          candidateFilename: string;
        };
        response: string;
      };
      safeDeleteFileOrFolder: {
        params: {
          absolutePath: string;
        };
      };
      execSpawnSync: {
        params: {
          cmd: string;
          args: string[];
          opts?: any;
        };
        response: string;
      };
      safeTrashFileOrFolder: {
        params: {
          path: string;
        };
      };
      createTerminal: {
        params: {
          cwd: string;
          shell?: string;
        };
        response: string;
      };
      writeToTerminal: {
        params: {
          terminalId: string;
          data: string;
        };
        response: boolean;
      };
      resizeTerminal: {
        params: {
          terminalId: string;
          cols: number;
          rows: number;
        };
        response: boolean;
      };
      killTerminal: {
        params: {
          terminalId: string;
        };
        response: boolean;
      };
      getTerminalCwd: {
        params: {
          terminalId: string;
        };
        response: string | null;
      };
      llamaCompletion: {
        params: {
          model: string;
          prompt: string;
          options?: {
            temperature?: number;
            top_p?: number;
            max_tokens?: number;
            repeat_penalty?: number;
            stop?: string[];
          };
        };
        response: {
          ok: boolean;
          response?: string;
          error?: string;
        };
      };
      llamaListModels: {
        params: void;
        response: {
          ok: boolean;
          models: Array<{
            name: string;
            path: string;
            size: number;
            modified: string;
            source: 'llama' | 'legacy';
          }>;
          error?: string;
        };
      };
      llamaInstallModel: {
        params: {
          modelRef: string; // e.g., "hf://Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/qwen2.5-coder-7b-instruct-q4_k_m.gguf"
        };
        response: {
          ok: boolean;
          downloading?: boolean;
          downloadId?: string;
          message?: string;
          error?: string;
        };
      };
      llamaDownloadStatus: {
        params: {
          downloadId?: string;
        };
        response: {
          ok: boolean;
          status?: {
            status: 'downloading' | 'completed' | 'failed';
            progress: number;
            fileName: string;
            error?: string;
          };
          downloads?: Record<string, any>;
          error?: string;
        };
      };
      llamaRemoveModel: {
        params: {
          modelPath: string;
        };
        response: {
          ok: boolean;
          error?: string;
        };
      };
      // Plugin system
      pluginSearch: {
        params: {
          query?: string;
          size?: number;
          from?: number;
        };
        response: {
          results: Array<{
            name: string;
            version: string;
            description?: string;
            author?: string;
            keywords?: string[];
            date: string;
            score: number;
            hasColabPlugin: boolean;
          }>;
          total: number;
        };
      };
      pluginGetInfo: {
        params: {
          packageName: string;
          version?: string;
        };
        response: {
          name: string;
          version: string;
          description?: string;
          author?: string | { name: string; email?: string };
          keywords?: string[];
          'colab-plugin'?: any;
        } | null;
      };
      pluginInstall: {
        params: {
          packageName: string;
          version?: string;
        };
        response: {
          ok: boolean;
          plugin?: {
            name: string;
            version: string;
            state: string;
            enabled: boolean;
          };
          error?: string;
        };
      };
      pluginUninstall: {
        params: {
          packageName: string;
        };
        response: {
          ok: boolean;
          error?: string;
        };
      };
      pluginActivate: {
        params: {
          packageName: string;
        };
        response: {
          ok: boolean;
          error?: string;
        };
      };
      pluginDeactivate: {
        params: {
          packageName: string;
        };
        response: {
          ok: boolean;
          error?: string;
        };
      };
      pluginSetEnabled: {
        params: {
          packageName: string;
          enabled: boolean;
        };
        response: {
          ok: boolean;
          error?: string;
        };
      };
      pluginGetInstalled: {
        params: void;
        response: Array<{
          name: string;
          version: string;
          displayName?: string;
          description?: string;
          state: string;
          enabled: boolean;
          installedAt: number;
          updatedAt: number;
          isLocal?: boolean;
          localPath?: string;
        }>;
      };
      pluginExecuteCommand: {
        params: {
          commandId: string;
          args?: unknown[];
        };
        response: {
          ok: boolean;
          result?: unknown;
          error?: string;
        };
      };
      pluginGetPreloadScripts: {
        params: void;
        response: string;
      };
      pluginGetCompletions: {
        params: {
          language: string;
          linePrefix: string;
          lineText: string;
          lineNumber: number;
          column: number;
          filePath: string;
          triggerCharacter?: string;
        };
        response: Array<{
          label: string;
          insertText: string;
          detail?: string;
          documentation?: string;
          kind?: string;
        }>;
      };
      pluginGetStatusBarItems: {
        params: void;
        response: Array<{
          id: string;
          text: string;
          tooltip?: string;
          color?: string;
          priority?: number;
          alignment?: 'left' | 'right';
          pluginName: string;
          hasSettings: boolean;
        }>;
      };
      pluginGetFileDecoration: {
        params: { filePath: string };
        response: {
          badge?: string;
          badgeColor?: string;
          tooltip?: string;
          faded?: boolean;
          color?: string;
        } | null;
      };
      pluginGetContextMenuItems: {
        params: { context: 'editor' | 'fileTree' };
        response: Array<{
          id: string;
          label: string;
          shortcutHint?: string;
        }>;
      };
      pluginExecuteContextMenuItem: {
        params: {
          itemId: string;
          filePath?: string;
          selection?: string;
        };
        response: { ok: boolean };
      };
      pluginGetKeybindings: {
        params: void;
        response: Array<{
          key: string;
          command: string;
          when?: 'editor' | 'terminal' | 'global';
        }>;
      };
      pluginGetSettingsSchemas: {
        params: void;
        response: Array<{
          pluginName: string;
          displayName?: string;
          schema: {
            title?: string;
            description?: string;
            fields: Array<{
              key: string;
              label: string;
              type: 'string' | 'number' | 'boolean' | 'select' | 'color';
              default?: string | number | boolean;
              description?: string;
              options?: Array<{ label: string; value: string | number }>;
              min?: number;
              max?: number;
              step?: number;
            }>;
          };
        }>;
      };
      pluginGetSettingsSchema: {
        params: { pluginName: string };
        response: {
          title?: string;
          description?: string;
          fields: Array<{
            key: string;
            label: string;
            type: 'string' | 'number' | 'boolean' | 'select' | 'color';
            default?: string | number | boolean;
            description?: string;
            options?: Array<{ label: string; value: string | number }>;
            min?: number;
            max?: number;
            step?: number;
          }>;
        } | null;
      };
      pluginGetSettingsValues: {
        params: { pluginName: string };
        response: Record<string, string | number | boolean>;
      };
      pluginSetSettingValue: {
        params: { pluginName: string; key: string; value: string | number | boolean };
        response: { ok: boolean };
      };
      pluginHasSettings: {
        params: { pluginName: string };
        response: boolean;
      };
      pluginGetEntitlements: {
        params: { pluginName: string };
        response: Array<{
          category: string;
          level: 'low' | 'medium' | 'high';
          icon: string;
          label: string;
          description: string;
        }>;
      };
    };
    messages: {
      removeProjectDirectoryWatcher: {
        projectId: string;
      };
      closeProjectDirectoryWatcher: {
        projectId: string;
      };
      tsServerRequest: {
        command: string;
        args: any;
        metadata: {
          workspaceId: string;
          windowId: string;
          editorId: string;
        };
      };
      formatFile: {
        path: string;
      };
      createWindow: {
        offset?: { x: number; y: number };
      } | void;
      closeWindow: void;
      openBunnyWindow: {
        screenX: number;
        screenY: number;
      };
      createWorkspace: void;
      updateWorkspace: {
        [key: string]: any;
      };
      hideWorkspace: void;
      installUpdateNow: void;
      addToken: {
        name: string;
        url: string;
        endpoint: string;
        token: string;
      };
      editProject: {
        projectId: string;
        projectName: string;
        path: string;
      };
      deleteToken: {
        tokenId: string;
      };
      deleteWorkspace: void;
      deleteWorkspaceCompletely: void;
      removeProjectFromColabOnly: {
        projectId: string;
      };
      fullyDeleteProjectFromDiskAndColab: {
        projectId: string;
      };
      fullyDeleteNodeFromDisk: {
        nodePath: string;
      };
      syncDevlink: {
        nodePath: string;
      };
      track: {
        event: keyof typeof track;
        properties?: any;
      };
    };
  }>;
  // to webview
  webview: RPCSchema<{
    requests: {};
    messages: {
      initState: {
        windowId: string;
        buildVars: any;
        paths: any;
        peerDependencies: any;
      };
      updateStatus: Partial<AppState["update"]>;
      setProjects: {
        projects: any;
        tokens: any;
        workspace: any;
        appSettings: any;
        bunnyDash: {
          currentWorkspaceId: string;
          currentLensId: string;
          workspaces: Array<{
            id: string;
            name: string;
            subtitle: string;
            isCurrent: boolean;
            currentLensId: string;
            currentLensIsActive: boolean;
            canExpand: boolean;
            lenses: Array<{
              id: string;
              name: string;
              description: string;
              workspaceId: string;
              isCurrent: boolean;
              isDirty: boolean;
            }>;
          }>;
        };
      };
      fileWatchEvent: {
        absolutePath: string;
        exists: boolean;
        isDelete: boolean;
        isAdding: boolean;
        isFile: boolean;
        isDir: boolean;
      };
      tsServerMessage: {
        message: ParsedResponseType;
        metadata: {
          workspaceId: string;
          windowId: string;
          editorId: string;
        };
      };
      focusTab: {
        tabId: string;
      };
      openNewTab: {
        nodePath: string;
      };
      openUrlInNewTab: {
        url: string;
      };
      showNodeSettings: {
        nodePath: string;
      };
      addChildNode: {
        nodePath: string;
        nodeType?: string;
      };
      createSpecialFile: {
        nodePath: string;
        fileType: string;
      };
      deleteProject: {
        projectId: string;
      };

      splitPaneContainer: {
        pathToPane: PanePathType;
        direction: "row" | "column";
      };
      findAllInFolderResult: {
        query: string;
        projectId: string;
        results: {
          path: string;
          line: number;
          column: number;
          match: string;
        }[];
      };
      findFilesInWorkspaceResult: {
        query: string;
        projectId: string;
        results: string[];
      };
      openCommandPalette: void;
      newBrowserTab: void;
      closeCurrentTab: void;
      closeCurrentWindow: void;
      openSettings: {
        settingsType: string;
      };
      handleGlobalShortcut: {
        key: string;
        ctrl: boolean;
        shift: boolean;
        alt: boolean;
        meta: boolean;
      };
      terminalOutput: {
        terminalId: string;
        data: string;
      };
      terminalExit: {
        terminalId: string;
        exitCode: number;
        signal?: number;
      };
      beginWindowTransition: {
        label: string;
      };
      endWindowTransition: {};
      // Open a file in the editor (from edit command, Open menu, or drag-drop)
      openFileInEditor: {
        filePath: string;
        createIfNotExists?: boolean;
      };
      // Open a folder as a project
      openFolderAsProject: {
        folderPath: string;
      };
      // Open a terminal at a specific directory
      newTerminal: {
        nodePath: string;
      };
      // Remove a file from the open files list
      removeOpenFile: {
        filePath: string;
      };
    };
  }>;
};
