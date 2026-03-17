import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  untrack,
} from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import { type Accessor } from "solid-js";
import { DiffEditor } from "../DiffEditor";
import { state, setState, openNewTabForNode } from "../store";

import { getProjectForNodePath } from "../files";
import type { CachedFileType } from "../../../shared/types/types";
import { join } from "../../utils/pathUtils";
import { electrobun } from "../init";
import { Dialog } from "../components/Dialog";

type FileChangeType = {
  changeType: "A" | "M" | "D" | "?" | "";
  relPath: string;
};

type FileChangesType = { [relPath: string]: FileChangeType };

type FileChangeWithCommitType = FileChangeType & {
  commitHash: string;
  isFromStaged?: boolean;
};

type UncommittedChangesType = {
  staged: FileChangesType;
  unstaged: FileChangesType;
  shortStat: string;
};

type CommitType = {
  author: string;
  date: number;
  hash: string;
  files: FileChangesType;
  message: string;
  shortStat: string;
  refs: string[];
  isRemoteOnly?: boolean;
};

type RemoteType = {
  name: string;
  refs: {
    fetch: string;
    push: string;
  };
};

type BranchInfo = {
  current: string;
  all: string[];
  remote: string[];
  trackingBranch?: string;
};

type SyncStatusType = {
  ahead: number;
  behind: number;
};

type UIStateType = {
  changes: UncommittedChangesType;
  log: CommitType[];
  stashes: { all: any[]; latest: any; total: number };
  originalText: string;
  modifiedText: string;
  remotes: RemoteType[];
  branches: BranchInfo;
  syncStatus: SyncStatusType;
  activeSection: 'branches' | 'remotes' | 'stashes';
};

// const relGitDirectory = join(__dirname, "/git");

// process.env.LOCAL_GIT_DIRECTORY = relGitDirectory;
const parseStatusLine = (line: string) => {
  const changeType = line.slice(0, 1);
  const relPath = line.slice(3);
  return {
    changeType,
    relPath,
  };
};

// todo (yoav): maybe we just give it a path and it fetches the node as needed
export const GitSlate = ({ node }: { node?: CachedFileType }) => {
  if (!node) {
    return null;
  }

  const repoRootPath = node.path.replace(/\.git/, "");

  let refreshLogAndStageTimeout: Timer;

  createEffect(() => {
    if (state.lastFileChange) {
      const absolutePath = state.lastFileChange;

      // Check if this change is relevant to this git repo
      const isInThisRepo = absolutePath.startsWith(repoRootPath);
      if (!isInThisRepo) {
        return;
      }

      // For .git/ folder changes, only react to meaningful ones (not lock files, etc.)
      if (absolutePath.includes("/.git/")) {
        // Ignore lock files - they're temporary and cause infinite loops
        if (absolutePath.endsWith(".lock")) {
          return;
        }

        // React to changes that indicate git state changed (commits, refs, index, etc.)
        const isGitStateChange =
          absolutePath.includes("/.git/refs/") ||
          absolutePath.endsWith("/.git/HEAD") ||
          absolutePath.endsWith("/.git/index") ||
          absolutePath.endsWith("/.git/COMMIT_EDITMSG") ||
          absolutePath.endsWith("/.git/FETCH_HEAD") ||
          absolutePath.endsWith("/.git/ORIG_HEAD") ||
          absolutePath.includes("/.git/logs/") ||
          absolutePath.includes("/.git/hooks/");

        if (!isGitStateChange) {
          return;
        }
      }

      clearTimeout(refreshLogAndStageTimeout);
      refreshLogAndStageTimeout = setTimeout(() => {
        getLogAndStatus();
        // Note: We no longer clear/reset selectedFile here to avoid remounting
        // the DiffEditor component. The diff content comparison in setUiState
        // will prevent unnecessary re-renders.
      }, 100);
    }
  });

  // Cleanup timeout on component unmount
  onCleanup(() => {
    clearTimeout(refreshLogAndStageTimeout);
  });

  // startWatching();

  // Note: InitialState must be defined inside the component
  // if it's global then the same object reference (which gets solidjs store setters/getters)
  // will be shared across GitSlate tabs even for different repos
  const initialState: UIStateType = {
    changes: { staged: {}, unstaged: {}, shortStat: "" },
    log: [],
    stashes: { all: [], latest: null, total: 0 },
    originalText: "",
    modifiedText: "",
    remotes: [],
    branches: { current: "", all: [], remote: [] },
    syncStatus: { ahead: 0, behind: 0 },
    activeSection: 'branches',
  };

  const [uiState, setUiState] = createStore(initialState);
  
  // Pagination state for infinite scroll
  const [pagination, setPagination] = createStore({
    limit: 50, // Load 50 commits at a time
    offset: 0,
    hasMore: true,
    isLoading: false,
  });

  // Add CSS animation for loading spinner
  const addSpinnerAnimation = () => {
    if (!document.getElementById('spinner-keyframes')) {
      const style = document.createElement('style');
      style.id = 'spinner-keyframes';
      style.innerHTML = `
        @keyframes spinner-rotate {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `;
      document.head.appendChild(style);
    }
  };
  addSpinnerAnimation();

  const [selectedFile, setSelectedFile] =
    createSignal<FileChangeWithCommitType>({
      commitHash: "",
      // oldPath: "",
      relPath: "",
      changeType: "",
    });

  const getFileContents = async (
    filepath: string,
    commitRef: string = "HEAD"
  ) => {
    console.log('getFileContents called:', filepath, commitRef);
    // todo (yoav): revisit this with simplegit, HEAD may have a different meaning
    if (commitRef === "WORKING") {
      // Special case: read from working directory
      const absolutePath = join(repoRootPath, filepath);
      const exists = await electrobun.rpc?.request.exists({ path: absolutePath });
      if (!exists) {
        return "";
      }
      const result = await electrobun.rpc?.request.readFile({ path: absolutePath });
      const content = result?.textContent || "";
      return content;
    } else if (commitRef === "INDEX") {
      // Special case: read from git index (staged version)
      const content = await electrobun.rpc?.request
        .gitShow({
          options: [`:${filepath}`], // :filename reads from index
          repoRoot: repoRootPath,
        })
        .catch(() => "");
      return content || "";
    } else if (commitRef !== "HEAD") {
      console.log('Reading from commit:', commitRef);
      const content = await electrobun.rpc?.request
        .gitShow({
          options: [`${commitRef}:${filepath}`],
          repoRoot: repoRootPath,
        })
        .catch((error) => {
          console.error('Git show error:', error);
          return "";
        });
      return content || "";
    } else {
      console.log('Reading from HEAD');
      // HEAD - get from git
      const content = await electrobun.rpc?.request
        .gitShow({
          options: [`HEAD:${filepath}`],
          repoRoot: repoRootPath,
        })
        .catch((error) => {
          console.error('Git show HEAD error:', error);
          return "";
        });
      return content || "";
    }
  };

  const getFileDiff = async (filepath: string, commitHash: string = "HEAD", changeType?: string, isStaged: boolean = false) => {
    if (commitHash === "HEAD") {
      // For uncommitted changes, handle staged vs unstaged differently
      if (isStaged) {
        // Staged changes: compare HEAD with staged version
        if (changeType === "A") {
          // Staged added file - compare empty with staged version
          const modifiedText = await getFileContents(filepath, "INDEX"); // This gets the staged version
          return { originalText: "", modifiedText: modifiedText || "" };
        } else if (changeType === "D") {
          // Staged deleted file - compare HEAD with empty
          const originalText = await getFileContents(filepath, "HEAD");
          return { originalText: originalText || "", modifiedText: "" };
        } else {
          // Staged modified file - compare HEAD with INDEX (staged version)
          const [originalText, modifiedText] = await Promise.all([
            getFileContents(filepath, "HEAD"), // Last committed version
            getFileContents(filepath, "INDEX"), // Staged version from index
          ]);
          return { originalText: originalText || "", modifiedText: modifiedText || "" };
        }
      } else {
        // Unstaged changes: compare HEAD with working directory
        if (changeType === "A") {
          // Unstaged added file - compare empty with working directory
          const modifiedText = await getFileContents(filepath, "WORKING");
          return { originalText: "", modifiedText: modifiedText || "" };
        } else if (changeType === "D") {
          // Unstaged deleted file - compare HEAD with empty
          const originalText = await getFileContents(filepath, "HEAD");
          return { originalText: originalText || "", modifiedText: "" };
        } else {
          // Unstaged modified file - compare INDEX (staged version) with working directory
          const [originalText, modifiedText] = await Promise.all([
            getFileContents(filepath, "INDEX"), // Use staged version as baseline
            getFileContents(filepath, "WORKING"),
          ]);
          return { originalText: originalText || "", modifiedText: modifiedText || "" };
        }
      }
    } else {
      // For historical commits, handle A/D files specially
      if (changeType === "A") {
        // Added file - no previous version exists
        const modifiedText = await getFileContents(filepath, commitHash);
        return { originalText: "", modifiedText: modifiedText || "" };
      } else if (changeType === "D") {
        // Deleted file - no current version exists
        const originalText = await getFileContents(filepath, commitHash + "^");
        return { originalText: originalText || "", modifiedText: "" };
      } else {
        // Modified file - compare with previous commit
        const [originalText, modifiedText] = await Promise.all([
          getFileContents(filepath, commitHash + "^"),
          getFileContents(filepath, commitHash),
        ]);
        return { originalText: originalText || "", modifiedText: modifiedText || "" };
      }
    }
  };

  const onClickChange = async (change: FileChangeType, commitHash = "HEAD", isFromStaged = false) => {
    setSelectedFile({
      commitHash,
      // oldPath: change.oldPath,
      relPath: change.relPath,
      changeType: change.changeType,
      isFromStaged: isFromStaged, // Track which section was clicked
    });
  };

  createEffect(async () => {
    const { commitHash, relPath, changeType, isFromStaged } = selectedFile();
    if (relPath) {
      try {
        // Use the explicit isFromStaged flag when available, otherwise fall back to detection
        let isStaged: boolean;
        if (isFromStaged !== undefined) {
          isStaged = isFromStaged;
          console.log(`Using explicit staged flag: ${isStaged} for ${relPath}`);
        } else {
          // Fallback: assume unstaged if file exists in unstaged, otherwise staged
          const isUnstaged = relPath in (uiState.changes.unstaged || {});
          isStaged = !isUnstaged;
          console.log(`Detected staged status: ${isStaged} for ${relPath} (unstaged: ${isUnstaged})`);
        }
        
        const { originalText, modifiedText } = await getFileDiff(
          relPath,
          commitHash,
          changeType,
          isStaged
        );

        // Only update if content actually changed to avoid unnecessary re-renders
        const newOriginal = originalText || "";
        const newModified = modifiedText || "";
        if (uiState.originalText !== newOriginal || uiState.modifiedText !== newModified) {
          setUiState({
            originalText: newOriginal,
            modifiedText: newModified,
          });
        }
      } catch (error) {
        console.error('Error loading diff:', error);
        setUiState({
          originalText: "Error loading file content",
          modifiedText: "Error loading file content",
        });
      }
    }
  });

  let backupLabelRef: HTMLInputElement | undefined;
  let descriptionRef: HTMLTextAreaElement | undefined;
  let amendRef: HTMLInputElement | undefined;
  
  // Reactive signals for form state
  const [subjectLength, setSubjectLength] = createSignal(0);
  const [isAmendChecked, setIsAmendChecked] = createSignal(false);
  const [subjectValue, setSubjectValue] = createSignal("");
  const [descriptionValue, setDescriptionValue] = createSignal("");
  const [showEmptyMessageError, setShowEmptyMessageError] = createSignal(false);

  // Stash form state
  const [showStashForm, setShowStashForm] = createSignal(false);
  const [stashMessage, setStashMessage] = createSignal("");
  
  const [showBranchInput, setShowBranchInput] = createSignal(false);
  const [branchInputValue, setBranchInputValue] = createSignal("");

  // Remote form state
  const [showRemoteInput, setShowRemoteInput] = createSignal(false);
  const [remoteNameValue, setRemoteNameValue] = createSignal("");
  const [remoteUrlValue, setRemoteUrlValue] = createSignal("");

  // Alt key state for modifier actions
  const [isAltPressed, setIsAltPressed] = createSignal(false);
  
  // Hover state for individual buttons
  const [isPullHovered, setIsPullHovered] = createSignal(false);
  const [isPushHovered, setIsPushHovered] = createSignal(false);
  
  // Branch name validation
  const validateBranchName = (name: string): { isValid: boolean; error?: string } => {
    if (!name.trim()) {
      return { isValid: false, error: "Branch name cannot be empty" };
    }
    
    // Git branch name rules:
    // - No spaces
    // - No special characters like ~, ^, :, \, ?, *, [
    // - Cannot start with . or /
    // - Cannot end with .lock
    // - Cannot contain .. 
    const invalidChars = /[\s~^:\\?*\[]/;
    if (invalidChars.test(name)) {
      return { isValid: false, error: "Branch name cannot contain spaces or special characters (~^:\\?*[)" };
    }
    
    if (name.startsWith('.') || name.startsWith('/')) {
      return { isValid: false, error: "Branch name cannot start with . or /" };
    }
    
    if (name.endsWith('.lock')) {
      return { isValid: false, error: "Branch name cannot end with .lock" };
    }
    
    if (name.includes('..')) {
      return { isValid: false, error: "Branch name cannot contain .." };
    }
    
    return { isValid: true };
  };
  
  const handleCreateBranch = async () => {
    const branchName = branchInputValue().trim();
    const validation = validateBranchName(branchName);

    if (!validation.isValid) {
      return;
    }

    try {
      console.log('Creating branch:', branchName);
      await electrobun.rpc?.request.gitCreateBranch({
        repoRoot: repoRootPath,
        branchName: branchName,
        options: []
      });
      console.log('Branch created, refreshing status...');
      // Small delay to ensure git operation is fully committed
      await new Promise(resolve => setTimeout(resolve, 1000));
      await getLogAndStatus();
      console.log('Status refreshed after branch creation');

      // Reset form state
      setShowBranchInput(false);
      setBranchInputValue("");
    } catch (error) {
      console.error('Failed to create branch:', error);
      // Keep the form open so user can see the error and try again
    }
  };

  // Remote name validation
  const validateRemoteName = (name: string): { isValid: boolean; error?: string } => {
    if (!name.trim()) {
      return { isValid: false, error: "Remote name cannot be empty" };
    }

    // Git remote name rules:
    // - No spaces
    // - No special characters
    const invalidChars = /[\s~^:\\?*\[]/;
    if (invalidChars.test(name)) {
      return { isValid: false, error: "Remote name cannot contain spaces or special characters" };
    }

    return { isValid: true };
  };

  // Remote URL validation
  const validateRemoteUrl = (url: string): { isValid: boolean; error?: string } => {
    if (!url.trim()) {
      return { isValid: false, error: "Remote URL cannot be empty" };
    }

    // Basic URL validation - check if it's a valid git URL
    const isValidUrl = url.match(/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/);
    if (!isValidUrl) {
      return { isValid: false, error: "Invalid URL format (must start with https://, git@, ssh://, or file://)" };
    }

    return { isValid: true };
  };

  const handleAddRemote = async () => {
    const remoteName = remoteNameValue().trim();
    const remoteUrl = remoteUrlValue().trim();
    const nameValidation = validateRemoteName(remoteName);
    const urlValidation = validateRemoteUrl(remoteUrl);

    if (!nameValidation.isValid || !urlValidation.isValid) {
      return;
    }

    try {
      console.log('Adding remote:', remoteName, remoteUrl);
      await electrobun.rpc?.request.gitAddRemote({
        repoRoot: repoRootPath,
        remoteName: remoteName,
        remoteUrl: remoteUrl
      });
      console.log('Remote added, refreshing status...');
      // Small delay to ensure git operation is fully committed
      await new Promise(resolve => setTimeout(resolve, 1000));
      await getLogAndStatus();
      console.log('Status refreshed after adding remote');

      // Reset form state
      setShowRemoteInput(false);
      setRemoteNameValue("");
      setRemoteUrlValue("");
    } catch (error) {
      console.error('Failed to add remote:', error);
      // Keep the form open so user can see the error and try again
    }
  };
  
  const [includeUntracked, setIncludeUntracked] = createSignal(false);
  
  // Remote expansion state
  const [expandedRemotes, setExpandedRemotes] = createSignal<Set<string>>(new Set());
  const [expandedStashes, setExpandedStashes] = createSignal<Set<string>>(new Set());
  const [stashFiles, setStashFiles] = createSignal<{[stashName: string]: any[]}>({});

  // Dialog state
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [dialogConfig, setDialogConfig] = createSignal({
    title: "",
    message: "",
    onConfirm: () => {},
    confirmText: "Confirm",
    type: "default" as "default" | "danger"
  });

  // Debug effect to monitor dialog state
  createEffect(() => {
    console.log('Dialog state changed - dialogOpen:', dialogOpen(), 'config:', dialogConfig());
  });

  // Debug effect to monitor description changes
  createEffect(() => {
    console.log('Description signal changed to:', descriptionValue());
  });

  // Helper function to show error dialogs
  const showErrorDialog = (title: string, error: any) => {
    const errorMessage = error?.message || error?.toString() || 'An unknown error occurred';
    setDialogConfig({
      title: title,
      message: errorMessage,
      confirmText: "OK",
      type: "danger",
      onConfirm: () => setDialogOpen(false),
    });
    setDialogOpen(true);
  };

  const undoLastCommit = async () => {
    try {
      // Get the commit message from the latest commit (now includes full message from backend)
      const latestCommit = uiState.log[0];
      const commitMessage = latestCommit?.message || '';
      
      console.log('Undoing commit with message:', commitMessage);
      
      // Split commit message into subject and description
      const lines = commitMessage.split('\n');
      const subject = lines[0] || '';
      const description = lines.slice(1).join('\n').trim();
      
      console.log('Subject:', subject);
      console.log('Description:', description);
      
      // Perform git reset --soft HEAD~1 to undo the last commit
      // This moves HEAD back one commit while keeping changes in working tree
      await electrobun.rpc?.request.gitReset({
        repoRoot: repoRootPath,
        options: ['--soft', 'HEAD~1']
      });
      
      // Refresh the git status and log after the reset first
      await getLogAndStatus();
      
      // Now restore the commit message using reactive signals
      console.log('Setting subject via signal to:', subject);
      console.log('Setting description via signal to:', description);
      console.log('Description length:', description.length);
      
      setSubjectValue(subject);
      setSubjectLength(subject.length);
      setDescriptionValue(description);
      
      // Debug: Check what the signals contain after setting
      console.log('Subject signal after setting:', subjectValue());
      console.log('Description signal after setting:', descriptionValue());
      
      // Fallback: Also try direct DOM manipulation as backup
      setTimeout(() => {
        if (descriptionRef) {
          console.log('Fallback: Setting textarea via DOM to:', description);
          descriptionRef.value = description;
          descriptionRef.textContent = description;
          console.log('Fallback: Textarea DOM value is now:', descriptionRef.value);
        }
      }, 100);
    } catch (error) {
      console.error('Error undoing last commit:', error);
    }
  };

  const softRevertCommit = async (commit: any) => {
    try {
      console.log('Soft reverting commit:', commit.hash, commit.message);
      
      // Use git revert with --no-commit to stage the revert changes without committing
      await electrobun.rpc?.request.gitRevert({
        repoRoot: repoRootPath,
        commitHash: commit.hash,
        options: ['--no-commit']
      });
      
      // Refresh the git status to show the reverted changes as staged
      await getLogAndStatus();
      
      console.log('Soft revert completed - changes are now staged');
    } catch (error) {
      console.error('Error soft reverting commit:', error);
    }
  };

  const stageAllFiles = async () => {
    try {
      const unstagedFiles = Object.keys(uiState.changes.unstaged || {});
      if (unstagedFiles.length === 0) return;
      
      console.log('Staging all files:', unstagedFiles);
      
      await electrobun.rpc?.request.gitAdd({
        files: unstagedFiles,
        repoRoot: repoRootPath,
      });
      
      // Refresh the git status
      await getLogAndStatus();
      
      console.log('Successfully staged all files');
    } catch (error) {
      console.error('Error staging all files:', error);
    }
  };

  const unstageAllFiles = async () => {
    try {
      const stagedFiles = Object.keys(uiState.changes.staged || {});
      if (stagedFiles.length === 0) return;
      
      console.log('Unstaging all files:', stagedFiles);
      
      await electrobun.rpc?.request.gitReset({
        repoRoot: repoRootPath,
        options: ['HEAD', '--', ...stagedFiles]
      });
      
      // Refresh the git status
      await getLogAndStatus();
      
      console.log('Successfully unstaged all files');
    } catch (error) {
      console.error('Error unstaging all files:', error);
    }
  };

  const onClickSaveBackup = async (e?: Event) => {
    e?.preventDefault();

    let subject = subjectValue()?.trim();
    let description = descriptionValue()?.trim();
    const isAmend = amendRef?.checked || false;

    if (!subject) {
      setShowEmptyMessageError(true);
      return;
    }

    // Clear error if we got here
    setShowEmptyMessageError(false);

    // Auto-split long subjects at 72 characters
    if (subject.length > 72) {
      const overflow = subject.slice(72).trim();
      subject = subject.slice(0, 72).trimEnd() + "...";
      // Prepend overflow to description
      description = description ? `${overflow}\n\n${description}` : overflow;
    }


    // Construct commit message (subject + description with blank line between)
    const commitMessage = description
      ? `${subject}\n\n${description}`
      : subject;

    console.log('commit message: ', commitMessage);
    // Clear form
    setSubjectValue("");
    setSubjectLength(0);
    setDescriptionValue("");
    setIsAmendChecked(false);
    if (amendRef) {
      amendRef.checked = false;
    }

    // Only commit what's already staged - don't auto-stage unstaged files
    const numPendingChanges = Object.keys(uiState.changes.staged || {}).length;

    // todo (yoav): let user specify git config in SlateBun per project
    // todo (yoav): fetch system git config if it exists
    if (numPendingChanges) {
      if (isAmend) {
        // For amend, we use git commit --amend
        await electrobun.rpc?.request.gitCommitAmend({
          msg: commitMessage,
          repoRoot: repoRootPath,
        });
      } else {
        await electrobun.rpc?.request.gitCommit({
          msg: commitMessage,
          repoRoot: repoRootPath,
        });
      }
    }

    await getLogAndStatus();
  };

  const getLogAndStatus = async (resetPagination = true) => {
    if (resetPagination) {
      setPagination({ offset: 0, hasMore: true, isLoading: false });
    }
    
    const [gitLog, gitStatus, shortStat, gitStashes, gitRemotes, gitBranches] = await Promise.all([
      electrobun.rpc?.request.gitLog({
        repoRoot: repoRootPath,
        options: ["--name-status"],
        limit: pagination.limit,
        skip: resetPagination ? 0 : pagination.offset,
      }),
      electrobun.rpc?.request.gitStatus({
        repoRoot: repoRootPath,
      }),
      electrobun.rpc?.request.gitDiff({
        repoRoot: repoRootPath,
        options: ["--shortstat", "HEAD"],
      }),
      electrobun.rpc?.request.gitStashList({
        repoRoot: repoRootPath,
      }),
      electrobun.rpc?.request.gitRemote({
        repoRoot: repoRootPath,
      }),
      electrobun.rpc?.request.gitBranch({
        repoRoot: repoRootPath,
        options: ["-a"], // Get all branches including remotes
      }),
    ]);

    // Fetch remote-only commits if we have a tracking branch
    let gitRemoteOnlyLog = { all: [] };
    if (gitStatus?.tracking && gitBranches?.current) {
      try {
        gitRemoteOnlyLog = await electrobun.rpc?.request.gitLogRemoteOnly({
          repoRoot: repoRootPath,
          localBranch: gitBranches.current,
          remoteBranch: gitStatus.tracking,
        }) || { all: [] };
        console.log('Remote-only commits:', gitRemoteOnlyLog.all?.length || 0);
      } catch (error) {
        console.error('Error fetching remote-only commits:', error);
      }
    }

    // Create a map of commit hash to refs (branches/tags)
    const refsMap = new Map<string, string[]>();
    
    // Add current branch to HEAD commit
    if (gitBranches?.current && gitLog?.all?.length > 0) {
      const headCommit = gitLog.all[0];
      if (headCommit) {
        const refs = [gitBranches.current];
        refsMap.set(headCommit.hash, refs);
        console.log('Added HEAD refs:', refs, 'to commit', headCommit.hash);
      }
    }
    
    // Add remote tracking branch indicators
    if (gitStatus?.tracking) {
      const trackingBranch = gitStatus.tracking;
      console.log('Tracking branch:', trackingBranch, 'ahead:', gitStatus.ahead, 'behind:', gitStatus.behind);
      
      if (gitStatus.ahead > 0) {
        // We are ahead - remote is behind us by gitStatus.ahead commits
        const remoteCommitIndex = gitStatus.ahead;
        console.log('Remote is behind by', gitStatus.ahead, 'commits, looking at index', remoteCommitIndex);
        
        if (gitLog?.all?.length > remoteCommitIndex) {
          const remoteCommit = gitLog.all[remoteCommitIndex];
          if (remoteCommit) {
            const existingRefs = refsMap.get(remoteCommit.hash) || [];
            existingRefs.push(trackingBranch);
            refsMap.set(remoteCommit.hash, existingRefs);
            console.log('Added remote tracking refs:', existingRefs, 'to commit', remoteCommit.hash, 'at index', remoteCommitIndex);
          }
        }
      } else if (gitStatus.behind > 0) {
        // We are behind - remote is ahead (but this case is less common for showing in history)
        console.log('We are behind the remote by', gitStatus.behind, 'commits');
        // Could add logic here if needed
      } else if (gitStatus.ahead === 0 && gitStatus.behind === 0) {
        // We are in sync - remote is at the same commit as us
        console.log('In sync with remote, adding remote ref to HEAD commit');
        if (gitLog?.all?.length > 0) {
          const headCommit = gitLog.all[0];
          const existingRefs = refsMap.get(headCommit.hash) || [];
          if (!existingRefs.includes(trackingBranch)) {
            existingRefs.push(trackingBranch);
            refsMap.set(headCommit.hash, existingRefs);
            console.log('Added remote tracking refs to HEAD:', existingRefs, 'to commit', headCommit.hash);
          }
        }
      }
    }

    // Process remote-only commits (these go at the top with lower opacity)
    const remoteOnlyCommits = gitRemoteOnlyLog?.all?.map((commit: any) => {
      return {
        author: commit.author_name,
        date: new Date(commit.date).getTime(),
        hash: commit.hash,
        files: commit.diff?.files?.reduce((acc: any, file: any) => {
          if (file.file) {
            acc[file.file] = {
              changeType: file.status || "",
              relPath: file.file,
            };
          }
          return acc;
        }, {}) || {},
        message: commit.message,
        body: commit.body,
        shortStat: `added: ${commit.diff?.insertions || 0} removed: ${commit.diff?.deletions || 0} changed: ${commit.diff?.changed || 0}`,
        refs: refsMap.get(commit.hash) || [],
        isRemoteOnly: true, // Flag to show with lower opacity
      };
    }) || [];

    // Process local commits
    const localCommits = gitLog?.all?.map((commit, index) => {
      // Debug the first commit to see what properties are available
      if (index === 0) {
        console.log('Raw commit object:', commit);
        console.log('Commit message:', commit.message);
        console.log('Commit body:', commit.body);
        console.log('Refs for this commit:', refsMap.get(commit.hash));
      }
      
      return {
        author: commit.author_name,
        date: new Date(commit.date).getTime(),
        hash: commit.hash,
        files: commit.diff?.files?.reduce((acc: any, file: any) => {
          if (file.file) {
            acc[file.file] = {
              changeType: file.status || "",
              relPath: file.file,
            };
          }
          return acc;
        }, {}) || {},
        message: commit.message,
        body: commit.body,
        shortStat: `added: ${commit.diff?.insertions || 0} removed: ${commit.diff?.deletions || 0} changed: ${commit.diff?.changed || 0}`,
        refs: refsMap.get(commit.hash) || [],
        isRemoteOnly: false,
      };
    }) || [];

    // Combine: remote-only commits first, then local commits
    const log = [...remoteOnlyCommits, ...localCommits];
    
    console.log('Combined log:', log.length, 'commits (', remoteOnlyCommits.length, 'remote-only,', localCommits.length, 'local)');

    // Separate staged and unstaged changes
    const staged: FileChangesType = {};
    const unstaged: FileChangesType = {};
    
    gitStatus?.files.forEach((file: any) => {
      if (file.path) {
        console.log(`File: ${file.path}, index: "${file.index}", working_dir: "${file.working_dir}"`);
        // file.index = staged changes (ready to commit)
        // file.working_dir = unstaged changes (not yet staged)
        if (file.index && file.index.trim() !== ' ' && file.index.trim() !== '' && file.index.trim() !== '?') {
          staged[file.path] = {
            changeType: file.index.trim(),
            relPath: file.path,
          };
          console.log(`  -> Added to staged: ${file.path} (${file.index.trim()})`);
        }
        if (file.working_dir && file.working_dir.trim() !== ' ' && file.working_dir.trim() !== '') {
          unstaged[file.path] = {
            changeType: file.working_dir.trim(),
            relPath: file.path,
          };
          console.log(`  -> Added to unstaged: ${file.path} (${file.working_dir.trim()})`);
        }
      }
    });

    const changes = {
      staged,
      unstaged,
      shortStat: shortStat || "",
    };

    // Process remotes
    const remotes = (gitRemotes || []).map((remote: any) => ({
      name: remote.name,
      refs: remote.refs,
    }));

    // Process branches
    const branches: BranchInfo = {
      current: gitBranches?.current || "",
      all: gitBranches?.all || [],
      remote: (gitBranches?.all || []).filter((b: string) => b.includes("remotes/")),
    };
    
    console.log('Branch data from git:', {
      current: gitBranches?.current,
      all: gitBranches?.all,
      allCount: gitBranches?.all?.length,
      rawGitBranches: gitBranches
    });
    
    console.log('UI branches before update:', {
      current: uiState.branches.current,
      all: uiState.branches.all
    });

    // Calculate sync status (ahead/behind)
    let syncStatus = { ahead: 0, behind: 0 };
    if (branches.current && remotes.length > 0) {
      // Check tracking branch
      const trackingBranch = gitStatus?.tracking;
      if (trackingBranch) {
        // Get ahead/behind from status
        syncStatus.ahead = gitStatus?.ahead || 0;
        syncStatus.behind = gitStatus?.behind || 0;
        branches.trackingBranch = trackingBranch;
      }
    }

    // Force SolidJS reactivity by clearing first, then setting
    setUiState('branches', { current: '', all: [], remote: [] });
    
    // Handle pagination: append or replace commits
    const finalLog = resetPagination ? log : [...uiState.log, ...log];
    
    setUiState({ 
      log: finalLog, 
      changes: changes, 
      stashes: gitStashes || [],
      remotes: remotes,
      branches: { ...branches }, // Force reactivity by creating new object
      syncStatus: syncStatus,
    });
    
    // Update pagination state
    setPagination({
      offset: resetPagination ? pagination.limit : pagination.offset + pagination.limit,
      hasMore: log.length === pagination.limit, // If we got a full batch, there might be more
      isLoading: false,
    });
    
    // Expand all remotes by default
    if (remotes.length > 0) {
      const allRemoteNames = new Set(remotes.map((r: any) => r.name as string));
      setExpandedRemotes(allRemoteNames);
    }
    
    console.log('UI updated with branches:', {
      current: branches.current,
      all: branches.all
    });
  };

  // Function to load more commits for infinite scroll
  const loadMoreCommits = async () => {
    if (pagination.isLoading || !pagination.hasMore) return;
    
    setPagination('isLoading', true);
    
    try {
      const gitLog = await electrobun.rpc?.request.gitLog({
        repoRoot: repoRootPath,
        options: ["--name-status"],
        limit: pagination.limit,
        skip: pagination.offset,
      });

      if (gitLog?.all) {
        // Process the new commits (similar to getLogAndStatus but only for commits)
        const newCommits = gitLog.all.map((commit: any, index: number) => {
          const files: FileChangesType = {};
          
          if (commit.diff && commit.diff.files) {
            commit.diff.files.forEach((file: any) => {
              files[file.file] = {
                changeType: file.changes > 0 ? (file.insertions > 0 ? "M" : "A") : "D",
                relPath: file.file,
              };
            });
          }

          return {
            author: commit.author_name || "Unknown",
            date: new Date(commit.date).getTime(),
            hash: commit.hash,
            files: files,
            message: commit.message || "",
            body: commit.body,
            shortStat: "",
            refs: [], // Will be populated if needed
            isRemoteOnly: false,
          };
        });

        // Append new commits to existing log
        setUiState('log', [...uiState.log, ...newCommits]);
        
        // Update pagination
        setPagination({
          offset: pagination.offset + pagination.limit,
          hasMore: gitLog.all.length === pagination.limit,
          isLoading: false,
        });
      } else {
        setPagination({ hasMore: false, isLoading: false });
      }
    } catch (error) {
      console.error('Error loading more commits:', error);
      setPagination('isLoading', false);
    }
  };

  // Stage a file
  const stageFile = async (filePath: string) => {
    await electrobun.rpc?.request.gitAdd({
      files: [filePath],
      repoRoot: repoRootPath,
    });
    await getLogAndStatus();
    
    // Force refresh of the currently selected file if it matches
    if (selectedFile().relPath === filePath) {
      const currentSelection = selectedFile();
      // Trigger a re-load by temporarily changing selection
      setSelectedFile({ ...currentSelection, commitHash: "TEMP" });
      setTimeout(() => {
        setSelectedFile(currentSelection);
      }, 0);
    }
  };

  // Unstage a file
  const unstageFile = async (filePath: string) => {
    await electrobun.rpc?.request.gitReset({
      repoRoot: repoRootPath,
      options: ["--", filePath], // Remove from index, keep in working directory
    });
    await getLogAndStatus();
    
    // Force refresh of the currently selected file if it matches
    if (selectedFile().relPath === filePath) {
      const currentSelection = selectedFile();
      
      // If we're viewing the staged version and it gets completely unstaged,
      // we should switch to showing the unstaged version or clear the diff
      if (currentSelection.isFromStaged) {
        // Check if the file still has unstaged changes
        const hasUnstagedChanges = Object.keys(uiState.changes.unstaged || {}).includes(filePath);
        
        if (hasUnstagedChanges) {
          // Switch to unstaged version
          setSelectedFile({
            ...currentSelection,
            isFromStaged: false
          });
        } else {
          // File has no changes at all, clear selection or show empty state
          setSelectedFile({
            commitHash: "",
            relPath: "",
            changeType: "",
            isFromStaged: false
          });
        }
      } else {
        // Just refresh the current view
        setSelectedFile({ ...currentSelection, commitHash: "TEMP" });
        setTimeout(() => {
          setSelectedFile(currentSelection);
        }, 0);
      }
    }
  };

  // Stage specific lines from a file using Monaco data
  const stageLines = async (filePath: string, startLine: number, endLine: number, lineChange?: any, originalText?: string, modifiedText?: string) => {
    try {
      // Check for undefined/null, not truthiness - empty string is valid for new files
      if (lineChange && originalText !== undefined && modifiedText !== undefined) {
        // Use the new Monaco-based staging approach
        const result = await electrobun.rpc?.request.gitStageMonacoChange({
          repoRoot: repoRootPath,
          filePath: filePath,
          originalContent: originalText,
          targetChange: lineChange,
          modifiedContent: modifiedText
        });
      } else {
        // Fallback to the old approach if Monaco data is missing
        const result = await electrobun.rpc?.request.gitStageSpecificLines({
          repoRoot: repoRootPath,
          filePath: filePath,
          startLine: startLine,
          endLine: endLine
        });
      }
      
      // Refresh git status to update UI
      await getLogAndStatus();
      
      // Force refresh of the currently selected file if it matches
      if (selectedFile().relPath === filePath) {
        const currentSelection = selectedFile();
        // Trigger a re-load by temporarily changing selection
        setSelectedFile({ ...currentSelection, commitHash: "TEMP" });
        setTimeout(() => {
          setSelectedFile(currentSelection);
        }, 0);
      }
    } catch (error) {
      console.error("Error staging specific lines:", error);
      throw new Error(`Failed to stage lines ${startLine}-${endLine}: ${error}`);
    }
  };


  // Unstage specific lines from a file using Monaco data
  const unstageLines = async (filePath: string, startLine: number, endLine: number, lineChange?: any, originalText?: string, stagedText?: string) => {
    try {
      // Check for undefined/null, not truthiness - empty string is valid for new files
      if (lineChange && originalText !== undefined && stagedText !== undefined) {
        // Use the new Monaco-based unstaging approach
        const result = await  electrobun.rpc?.request.gitUnstageMonacoChange({
          repoRoot: repoRootPath,
          filePath: filePath,
          originalContent: originalText,  // HEAD version
          targetChange: lineChange,
          stagedContent: stagedText      // INDEX version (currently staged)
        });
      } else {
        // Fallback to unstaging the entire file if Monaco data is missing
        await unstageFile(filePath);
      }
      
      // Refresh git status to update UI
      await getLogAndStatus();
      
      // Force refresh of the currently selected file if it matches
      if (selectedFile().relPath === filePath) {
        const currentSelection = selectedFile();
        // Trigger a re-load by temporarily changing selection
        setSelectedFile({ ...currentSelection, commitHash: "TEMP" });
        setTimeout(() => {
          setSelectedFile(currentSelection);
        }, 0);
      }
    } catch (error) {
      console.error("Error unstaging specific lines:", error);
      throw new Error(`Failed to unstage lines ${startLine}-${endLine}: ${error}`);
    }
  };

  // Stash operations
  const createStash = async () => {
    try {
      const message = stashMessage().trim() || "Stash from Colab";
      const options = includeUntracked() ? ["-u"] : [];
      
      await electrobun.rpc?.request.gitStashCreate({
        repoRoot: repoRootPath,
        message: message,
        options: options,
      });
      
      // Reset form
      setStashMessage("");
      setIncludeUntracked(false);
      setShowStashForm(false);
      
      await getLogAndStatus();
    } catch (error) {
      console.error('Error creating stash:', error);
    }
  };

  const applyStash = async (stashName: string) => {
    try {
      await electrobun.rpc?.request.gitStashApply({
        repoRoot: repoRootPath,
        stashName: stashName,
      });
      await getLogAndStatus();
    } catch (error) {
      console.error('Error applying stash:', error);
    }
  };

  const popStash = async (stashName: string) => {
    try {
      await electrobun.rpc?.request.gitStashPop({
        repoRoot: repoRootPath,
        stashName: stashName,
      });
      await getLogAndStatus();
    } catch (error) {
      console.error('Error popping stash:', error);
    }
  };

  const dropStash = async (stashName: string) => {
    try {
      await electrobun.rpc?.request.execSpawnSync({
        cmd: 'git',
        args: ['stash', 'drop', stashName],
        opts: { cwd: repoRootPath },
      });
      await getLogAndStatus();
    } catch (error) {
      console.error('Error dropping stash:', error);
    }
  };

  const fetchStashFiles = async (stashName: string) => {
    try {
      const stashContent = await electrobun.rpc?.request.gitStashShow({
        repoRoot: repoRootPath,
        stashName: stashName,
      });
      
      // Parse the name-status output into file changes
      const files = stashContent.split('\n')
        .filter(line => line.trim())
        .map(line => {
          const parts = line.trim().split('\t');
          const changeType = parts[0];
          const filePath = parts[1];
          return {
            changeType,
            relPath: filePath,
          };
        });
      
      setStashFiles(prev => ({
        ...prev,
        [stashName]: files
      }));
    } catch (error) {
      console.error('Error fetching stash files:', error);
    }
  };

  const discardFileChanges = (filePath: string) => {
    console.log('discardFileChanges called with:', filePath);
    const change = uiState.changes.unstaged[filePath];
    if (!change) {
      console.log('No change found for:', filePath);
      return;
    }
    
    // Different confirmation messages based on change type
    let title, message;
    if (change.changeType === '?' || change.changeType === 'A') {
      title = "Delete New File";
      message = `Are you sure you want to delete the new file "${filePath}"? This action cannot be undone.`;
    } else {
      title = "Discard Changes";
      message = `Are you sure you want to discard all changes in "${filePath}"? This action cannot be undone.`;
    }
    
    console.log('Setting dialog config:', { title, message });
    setDialogConfig({
      title,
      message,
      confirmText: (change.changeType === '?' || change.changeType === 'A') ? "Delete" : "Discard",
      type: "danger",
      onConfirm: async () => {
        setDialogOpen(false);
        try {
          if (change.changeType === '?' || change.changeType === 'A') {
            // For new/untracked files, delete them
            const fullPath = filePath.startsWith('/') 
              ? filePath 
              : `${repoRootPath}/${filePath}`;
            await electrobun.rpc?.request.safeDeleteFileOrFolder({
              absolutePath: fullPath,
            });
          } else {
            // First try regular checkout
            const result = await electrobun.rpc?.request.execSpawnSync({
              cmd: 'git',
              args: ['checkout', '--', filePath],
              opts: { cwd: repoRootPath },
            }) as { stdout?: string; stderr?: string; exitCode?: number | null } | string | undefined;

            // If that fails due to unmerged file, try reset then checkout
            const output = typeof result === 'string' ? result : (result?.stdout || result?.stderr || '');
            if (output.includes('unmerged')) {
              // Reset the file in the index first
              await electrobun.rpc?.request.execSpawnSync({
                cmd: 'git',
                args: ['reset', '--', filePath],
                opts: { cwd: repoRootPath },
              });
              // Then checkout from HEAD
              await electrobun.rpc?.request.execSpawnSync({
                cmd: 'git',
                args: ['checkout', 'HEAD', '--', filePath],
                opts: { cwd: repoRootPath },
              });
            }
          }
          await getLogAndStatus();
        } catch (error) {
          console.error('Error discarding changes:', error);
        }
      }
    });
    console.log('Setting dialog open to true');
    setDialogOpen(true);
  };

  const discardAllChanges = () => {
    const fileCount = Object.keys(uiState.changes.unstaged || {}).length;
    
    setDialogConfig({
      title: "Discard All Changes",
      message: `Are you sure you want to discard all changes in ${fileCount} file(s)? This action cannot be undone.`,
      confirmText: "Discard All",
      type: "danger",
      onConfirm: async () => {
        setDialogOpen(false);
        try {
          // Handle each file individually to properly deal with new files
          for (const [filePath, change] of Object.entries(uiState.changes.unstaged)) {
            if (change.changeType === '?' || change.changeType === 'A') {
              // Delete new/untracked files
              const fullPath = filePath.startsWith('/') 
                ? filePath 
                : `${repoRootPath}/${filePath}`;
              await electrobun.rpc?.request.safeDeleteFileOrFolder({
                absolutePath: fullPath,
              });
            } else {
              // Discard changes for modified/deleted files
              try {
                await electrobun.rpc?.request.execSpawnSync({
                  cmd: 'git',
                  args: ['checkout', '--', filePath],
                  opts: { cwd: repoRootPath },
                });
              } catch (checkoutError) {
                // If unmerged, reset then checkout
                await electrobun.rpc?.request.execSpawnSync({
                  cmd: 'git',
                  args: ['reset', '--', filePath],
                  opts: { cwd: repoRootPath },
                });
                await electrobun.rpc?.request.execSpawnSync({
                  cmd: 'git',
                  args: ['checkout', 'HEAD', '--', filePath],
                  opts: { cwd: repoRootPath },
                });
              }
            }
          }
          await getLogAndStatus();
        } catch (error) {
          console.error('Error discarding all changes:', error);
        }
      }
    });
    setDialogOpen(true);
  };

  // todo (yoav): you could add filewatchers in here for just the .git folder for both status and log
  getLogAndStatus();

  // Alt key tracking for modifier actions
  createEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && !isAltPressed()) {
        setIsAltPressed(true);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!e.altKey && isAltPressed()) {
        setIsAltPressed(false);
      }
    };

    // Track focus/blur to reset state when window loses focus
    const handleBlur = () => {
      setIsAltPressed(false);
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    onCleanup(() => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    });
  });


  // setTimeout(() => {
  // getLogAndStage({ justStage: true });
  // }, 5000)

  // setTimeout(() => {
  //     stageAllFiles()
  // }, 10000)

  const onClickRestore = async (commit: CommitType) => {
    // There's no way to really do this with git alone.
    const tempRootPath =
      (repoRootPath.endsWith("/") ? repoRootPath.slice(0, -1) : repoRootPath) +
      "-temp-" +
      Date.now();
    const backupPath = tempRootPath + "-backup";
    const tempGitPath = join(tempRootPath, ".git");
    const originalGitPath = join(repoRootPath, ".git");

    const project = getProjectForNodePath(node.path);

    if (!project) {
      console.error("no project for node path");
      return;
    }
    // Recreate the file watchers because we're actually going to move and replace the entire folder.
    electrobun.rpc?.send("removeProjectDirectoryWatcher", {
      projectId: project.id,
    });

    // const oldGitWatcher = watcher;
    // oldGitWatcher.close();

    // maybe save a backup if their are uncommitted changes
    if (backupLabelRef) {
      backupLabelRef.value =
        backupLabelRef.value || "Pre—restore backup -> " + Date().toString();
    }
    await onClickSaveBackup();

    // duplicate the repo and checkout the target commit in that duplicate repo
    await electrobun.rpc?.request.copy({
      src: repoRootPath,
      dest: tempRootPath,
    });

    await electrobun.rpc?.request.gitCheckout({
      repoRoot: tempRootPath,
      hash: commit.hash,
    });
    // replace that duplicate repo's .git folder with the original
    await electrobun.rpc?.request.safeDeleteFileOrFolder({
      absolutePath: tempGitPath,
    });

    await electrobun.rpc?.request.copy({
      src: originalGitPath,
      dest: tempGitPath,
    });

    // save the original repo as -backup just in case and replace the duplicate to the original
    await electrobun.rpc?.request.rename({
      oldPath: repoRootPath,
      newPath: backupPath,
    });
    await electrobun.rpc?.request.rename({
      oldPath: tempRootPath,
      newPath: repoRootPath,
    });

    // Save the restored state as a new backup
    if (backupLabelRef) {
      backupLabelRef.value = `Restored -> ${commit.message} (${commit.hash})`;
    }

    await onClickSaveBackup();

    electrobun.rpc?.send("removeProjectDirectoryWatcher", {
      projectId: project.id,
    });

    await electrobun.rpc?.request.safeTrashFileOrFolder({ path: backupPath });
  };

  return (
    <div style={{ height: "100%", display: "flex" }}>
      <div
        id="backup-sidbar"
        style={{
          width: "500px",
          "min-width": "340px",
          height: "100%",
          overflow: "scroll",
          background: "#4d4d4d",
          color: "#e0e0e0",
        }}
      >
        <div
          id="side-bar-scroll"
          style={{ 
            height: "100%", 
            background: "#252526",
            display: "flex",
            "flex-direction": "column"
          }}
        >
          {/* Unstaged Changes Section - Flex Item 1 */}
          <div style={{             
            display: "flex", 
            "flex-direction": "column",
            "overflow-y": "scroll",
            'max-height': '50%'
          }}>
            {/* Unstaged Changes Section */}
            <div
              style={{
                background: "#1e1e1e",
                color: "#cccccc",
                padding: "8px 12px",
                "font-size": "11px",
                "font-weight": "600",
                "text-transform": "uppercase",
                "letter-spacing": "0.5px",
                "font-family": "'Segoe UI', system-ui, sans-serif",
                "border-bottom": "1px solid #2d2d2d",
                display: "flex",
                "justify-content": "space-between",
                "align-items": "center",
                "flex-shrink": "0",
              }}
            >
              <span>Changes ({Object.keys(uiState.changes.unstaged || {}).length})</span>
              <Show when={Object.keys(uiState.changes.unstaged || {}).length > 0}>
                <div style={{ display: "flex", gap: "4px" }}>
                  <button
                    style={{
                      background: "transparent",
                      border: "1px solid #555",
                      color: "#cccccc",
                      "font-size": "10px",
                      padding: "2px 6px",
                      "border-radius": "3px",
                      cursor: "pointer",
                      "font-family": "'Segoe UI', system-ui, sans-serif",
                      display: "flex",
                      "align-items": "center",
                      gap: "3px",
                    }}
                    onClick={discardAllChanges}
                    onMouseEnter={(e) => e.currentTarget.style.background = "#555"}
                    onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                    title="Discard all unstaged changes"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="9"
                      height="9"
                      viewBox="0 0 24 24"
                      fill="none"
                      style={{ display: "block" }}
                    >
                      <path
                        d="M10 8H5V3M5.29102 16.3569C6.22284 17.7918 7.59014 18.8902 9.19218 19.4907C10.7942 20.0913 12.547 20.1624 14.1925 19.6937C15.8379 19.225 17.2893 18.2413 18.3344 16.8867C19.3795 15.5321 19.963 13.878 19.9989 12.1675C20.0347 10.4569 19.5211 8.78001 18.5337 7.38281C17.5462 5.98561 16.1366 4.942 14.5122 4.40479C12.8878 3.86757 11.1341 3.86499 9.5083 4.39795C7.88252 4.93091 6.47059 5.97095 5.47949 7.36556"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                    <span>Discard All</span>
                  </button>
                  <button
                    style={{
                      background: "transparent",
                      border: "1px solid #555",
                      color: "#cccccc",
                      "font-size": "10px",
                      padding: "2px 6px",
                      "border-radius": "3px",
                      cursor: "pointer",
                      "font-family": "'Segoe UI', system-ui, sans-serif",
                      display: "flex",
                      "align-items": "center",
                      gap: "3px",
                    }}
                    onClick={stageAllFiles}
                    onMouseEnter={(e) => e.currentTarget.style.background = "#555"}
                    onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                  >
                    <span>+</span>
                    <span>Stage All</span>
                  </button>
                </div>
              </Show>
            </div>            
            <Show when={Object.keys(uiState.changes.unstaged || {}).length > 0}>
              <div
                style={{
                  
                  "min-height": "0",
                  overflow: "auto",
                  background: "#252526",
                  color: "#cccccc",
                }}
              >
                <FileList
                  files={() => uiState.changes.unstaged}
                  commitHash="HEAD"
                  onClick={(change, commitHash) => onClickChange(change, commitHash, false)}
                  selectedFile={selectedFile}
                  showStageButtons={true}
                  onStage={stageFile}
                  onUnstage={unstageFile}
                  onDiscard={discardFileChanges}
                  isStaged={false}
                  repoRootPath={repoRootPath}
                />
              </div>
            </Show>
          </div>

          {/* Staged Changes Section - Flex Item 2 */}
          <Show when={Object.keys(uiState.changes.staged || {}).length > 0}>
            <div style={{ 
              
              display: "flex", 
              "flex-direction": "column",
              "overflow-y": "scroll",
              'max-height': '50%'
            }}>
              <div
                style={{
                  background: "#1e1e1e",
                  color: "#cccccc",
                  padding: "8px 12px",
                  "font-size": "11px",
                  "font-weight": "600",
                  "text-transform": "uppercase",
                  "letter-spacing": "0.5px",
                  "font-family": "'Segoe UI', system-ui, sans-serif",
                  "border-bottom": "1px solid #2d2d2d",
                  display: "flex",
                  "justify-content": "space-between",
                  "align-items": "center",
                  "flex-shrink": "0",
                }}
              >
                <span>Staged Changes ({Object.keys(uiState.changes.staged || {}).length})</span>
                <button
                  style={{
                    background: "transparent",
                    border: "1px solid #555",
                    color: "#cccccc",
                    "font-size": "10px",
                    padding: "2px 6px",
                    "border-radius": "3px",
                    cursor: "pointer",
                    "font-family": "'Segoe UI', system-ui, sans-serif",
                    display: "flex",
                    "align-items": "center",
                    gap: "3px",
                  }}
                  onClick={unstageAllFiles}
                  onMouseEnter={(e) => e.currentTarget.style.background = "#555"}
                  onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                >
                  <span>−</span>
                  <span>Unstage All</span>
                </button>
              </div>
              <div
                style={{
                  flex: "1",
                  "min-height": "0",
                  overflow: "auto",
                  background: "#252526",
                  color: "#cccccc",
                }}
              >
                <form style={{ padding: "12px" }} onSubmit={onClickSaveBackup}>
                  {/* Subject Line */}
                  <div style={{ "margin-bottom": "8px" }}>
                    <div
                      style={{
                        display: "flex",
                        "justify-content": "space-between",
                        "align-items": "center",
                        "margin-bottom": "4px",
                      }}
                    >
                      <label
                        style={{
                          color: "#cccccc",
                          "font-size": "11px",
                          "font-weight": "600",
                          "font-family": "'Segoe UI', system-ui, sans-serif",
                        }}
                      >
                        SUMMARY
                      </label>
                      <span
                        style={{
                          color: subjectLength() > 50 ? "#f87171" : "#858585",
                          "font-size": "10px",
                          "font-family": "'Segoe UI Mono', monospace",
                        }}
                      >
                        {subjectLength()}/50
                      </span>
                    </div>
                    <input
                      type="text"
                      ref={backupLabelRef}
                      name="subject"
                      placeholder="Brief description of changes"
                      value={subjectValue()}
                      style={{
                        width: "100%",
                        background: "#3c3c3c",
                        border: subjectLength() > 50
                          ? "1px solid #f87171"
                          : "1px solid #464647",
                        "border-radius": "2px",
                        color: "#cccccc",
                        outline: "none",
                        "font-family": "'Segoe UI', system-ui, sans-serif",
                        "font-size": "13px",
                        padding: "8px 12px",
                        "box-sizing": "border-box",
                      }}
                      onInput={(e) => {
                        const value = e.currentTarget.value;
                        setSubjectValue(value);
                        setSubjectLength(value.length);
                        // Clear error when user starts typing
                        if (showEmptyMessageError()) {
                          setShowEmptyMessageError(false);
                        }
                      }}
                    />

                    {/* Error message for empty commit message */}
                    <Show when={showEmptyMessageError()}>
                      <div
                        style={{
                          color: "#f87171",
                          "font-size": "11px",
                          "font-family": "'Segoe UI', system-ui, sans-serif",
                          "margin-top": "4px",
                          "padding-left": "2px",
                        }}
                      >
                        Commit message cannot be empty
                      </div>
                    </Show>
                  </div>

                  {/* Description */}
                  <div style={{ "margin-bottom": "12px" }}>
                    <label
                      style={{
                        color: "#cccccc",
                        "font-size": "11px",
                        "font-weight": "600",
                        "font-family": "'Segoe UI', system-ui, sans-serif",
                        display: "block",
                        "margin-bottom": "4px",
                      }}
                    >
                      DESCRIPTION (OPTIONAL)
                    </label>
                    <textarea
                      ref={descriptionRef}
                      name="description"
                      placeholder="Explain what and why..."
                      rows="3"
                      value={descriptionValue()}
                      style={{
                        width: "100%",
                        background: "#3c3c3c",
                        border: "1px solid #464647",
                        "border-radius": "2px",
                        color: "#cccccc",
                        outline: "none",
                        "font-family": "'Segoe UI', system-ui, sans-serif",
                        "font-size": "12px",
                        padding: "8px 12px",
                        resize: "vertical",
                        "min-height": "60px",
                        "box-sizing": "border-box",
                      }}
                      onInput={(e) => {
                        setDescriptionValue(e.currentTarget.value);
                      }}
                    />
                  </div>

                  {/* Amend Checkbox */}
                  <div style={{ "margin-bottom": "12px" }}>
                    <label
                      style={{
                        display: "flex",
                        "align-items": "center",
                        color: "#cccccc",
                        "font-size": "12px",
                        "font-family": "'Segoe UI', system-ui, sans-serif",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        ref={amendRef}
                        style={{
                          "margin-right": "8px",
                          "accent-color": "#0078d4",
                        }}
                        onChange={(e) => {
                          const checked = e.currentTarget.checked;
                          setIsAmendChecked(checked);

                          if (checked) {
                            // Get the last local commit (not remote-only)
                            const lastCommit = uiState.log?.find(c => !c.isRemoteOnly);
                            if (lastCommit) {
                              // Populate the form with the last commit's message
                              const fullMessage = lastCommit.body
                                ? `${lastCommit.message}\n\n${lastCommit.body}`
                                : lastCommit.message;

                              const lines = fullMessage.split('\n');
                              const subject = lines[0];
                              const description = lines.slice(1).join('\n').trim();

                              setSubjectValue(subject);
                              setSubjectLength(subject.length);
                              setDescriptionValue(description);
                            }
                          } else {
                            // Clear the form when unchecking amend
                            setSubjectValue("");
                            setSubjectLength(0);
                            setDescriptionValue("");
                          }
                        }}
                      />
                      Amend previous commit
                    </label>
                  </div>

                  {/* Commit Button */}
                  <button
                    type="submit"
                    style={{
                      background: "#0e639c",
                      border: "none",
                      "border-radius": "2px",
                      color: "#ffffff",
                      cursor: "pointer",
                      "font-family": "'Segoe UI', system-ui, sans-serif",
                      "font-size": "13px",
                      "font-weight": "600",
                      padding: "8px 16px",
                      width: "100%",
                      transition: "background 0.15s ease",
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = "#1177bb"}
                    onMouseLeave={(e) => e.currentTarget.style.background = "#0e639c"}
                  >
                    {isAmendChecked() ? "Amend Commit" : "Commit"}
                  </button>
                </form>

                <FileList
                  files={() => uiState.changes.staged}
                  commitHash="HEAD"
                  onClick={(change, commitHash) => onClickChange(change, commitHash, true)}
                  selectedFile={selectedFile}
                  showStageButtons={true}
                  onStage={stageFile}
                  onUnstage={unstageFile}
                  isStaged={true}
                  repoRootPath={repoRootPath}
                />
              </div>
            </div>
          </Show>

          {/* History Section - Flex Item 3 */}
          <div style={{ 
            flex: "2", 
            display: "flex", 
            "flex-direction": "column",
            overflow: "hidden"
          }}>
            <div
              style={{
                background: "#1e1e1e",
                color: "#cccccc",
                padding: "8px 12px",
                "font-size": "11px",
                "font-weight": "600",
                "text-transform": "uppercase",
                "letter-spacing": "0.5px",
                "font-family": "'Segoe UI', system-ui, sans-serif",
                "border-bottom": "1px solid #2d2d2d",
                "flex-shrink": "0",
                display: "flex",
                "justify-content": "space-between",
                "align-items": "center",
              }}
            >
              <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                <span>History ({uiState.log.length})</span>
                <Show when={uiState.syncStatus && (uiState.syncStatus.ahead > 0 || uiState.syncStatus.behind > 0)}>
                  <span style={{ 
                    "font-size": "10px", 
                    "font-weight": "normal",
                    color: "#858585",
                    "margin-left": "4px"
                  }}>
                    <Show when={uiState.syncStatus.behind > 0}>
                      <span style={{ color: "#f87171" }}>↓{uiState.syncStatus.behind}</span>
                    </Show>
                    <Show when={uiState.syncStatus.ahead > 0}>
                      <span style={{ color: "#4ade80", "margin-left": uiState.syncStatus.behind > 0 ? "4px" : "0" }}>↑{uiState.syncStatus.ahead}</span>
                    </Show>
                  </span>
                </Show>
              </div>
              <Show when={uiState.remotes?.length > 0}>
                <div style={{ display: "flex", gap: "4px" }}>
                  <button
                    style={{
                      background: "transparent",
                      border: "1px solid #555",
                      color: "#cccccc",
                      "font-size": "10px",
                      padding: "3px 8px",
                      "border-radius": "3px",
                      cursor: "pointer",
                      "font-family": "'Segoe UI', system-ui, sans-serif",
                      display: "flex",
                      "align-items": "center",
                      gap: "4px",
                    }}
                    onClick={async () => {
                      try {
                        await electrobun.rpc?.request.gitFetch({
                          repoRoot: repoRootPath,
                          remote: undefined,
                          options: [],
                        });
                        await getLogAndStatus();
                      } catch (error) {
                        console.error('Fetch failed:', error);
                        showErrorDialog('Fetch Failed', error);
                      }
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = "#555"}
                    onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                  >
                    Fetch
                  </button>
                  <button
                    style={{
                      background: "transparent",
                      border: "1px solid #555",
                      color: "#cccccc",
                      "font-size": "10px",
                      padding: "3px 8px",
                      "border-radius": "3px",
                      cursor: "pointer",
                      "font-family": "'Segoe UI', system-ui, sans-serif",
                      display: "flex",
                      "align-items": "center",
                      gap: "4px",
                      opacity: uiState.syncStatus?.behind > 0 ? "1" : "0.5",
                      "white-space": "nowrap",
                    }}
                    disabled={uiState.syncStatus?.behind === 0}
                    onClick={async () => {
                      try {
                        await electrobun.rpc?.request.gitPull({
                          repoRoot: repoRootPath,
                          remote: undefined,
                          branch: undefined,
                          options: isAltPressed() ? ['--rebase'] : [],
                        });
                        await getLogAndStatus();
                      } catch (error) {
                        console.error('Pull failed:', error);
                        showErrorDialog('Pull Failed', error);
                      }
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "#555";
                      setIsPullHovered(true);
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                      setIsPullHovered(false);
                    }}
                  >
                    {isAltPressed() && isPullHovered() ? 'Pull --rebase' : 'Pull'}
                    <Show when={uiState.syncStatus?.behind > 0}>
                      <span style={{ color: "#f87171" }}>({uiState.syncStatus.behind})</span>
                    </Show>
                  </button>
                  <button
                    style={{
                      background: "transparent",
                      border: "1px solid #555",
                      color: "#cccccc",
                      "font-size": "10px",
                      padding: "3px 8px",
                      "border-radius": "3px",
                      cursor: "pointer",
                      "font-family": "'Segoe UI', system-ui, sans-serif",
                      display: "flex",
                      "align-items": "center",
                      gap: "4px",
                      opacity: (uiState.syncStatus?.ahead > 0 || isAltPressed()) ? "1" : "0.5",
                      "white-space": "nowrap",
                    }}
                    disabled={!isAltPressed() && uiState.syncStatus?.ahead === 0}
                    onClick={async () => {
                      // If Alt is pressed (force push), show confirmation dialog
                      if (isAltPressed()) {
                        setDialogConfig({
                          title: "Force Push Confirmation",
                          message: "Force push will overwrite the remote branch history. This can cause data loss for other collaborators. Are you sure you want to continue?",
                          confirmText: "Force Push",
                          cancelText: "Cancel",
                          type: "danger",
                          onConfirm: async () => {
                            setDialogOpen(false);
                            try {
                              await electrobun.rpc?.request.gitPush({
                                repoRoot: repoRootPath,
                                remote: undefined,
                                branch: undefined,
                                options: ['--force'],
                              });
                              await getLogAndStatus();
                            } catch (error) {
                              console.error('Force push failed:', error);
                              showErrorDialog('Force Push Failed', error);
                            }
                          },
                          onCancel: () => setDialogOpen(false)
                        });
                        setDialogOpen(true);
                      } else {
                        // Normal push
                        try {
                          await electrobun.rpc?.request.gitPush({
                            repoRoot: repoRootPath,
                            remote: undefined,
                            branch: undefined,
                            options: [],
                          });
                          await getLogAndStatus();
                        } catch (error) {
                          console.error('Push failed:', error);
                          showErrorDialog('Push Failed', error);
                        }
                      }
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "#555";
                      setIsPushHovered(true);
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                      setIsPushHovered(false);
                    }}
                  >
                    {isAltPressed() && isPushHovered() ? 'Push --force' : 'Push'}
                    <Show when={uiState.syncStatus?.ahead > 0}>
                      <span style={{ color: "#4ade80" }}>({uiState.syncStatus.ahead})</span>
                    </Show>
                  </button>
                </div>
              </Show>
            </div>

            <div
              style={{
                flex: "1",
                "min-height": "0",
                overflow: "auto",
              }}
              onScroll={(e) => {
                const target = e.currentTarget;
                const scrollTop = target.scrollTop;
                const scrollHeight = target.scrollHeight;
                const clientHeight = target.clientHeight;
                
                // Trigger load more when within 100px of bottom
                if (scrollHeight - scrollTop - clientHeight < 100) {
                  if (pagination.hasMore && !pagination.isLoading) {
                    loadMoreCommits();
                  }
                }
              }}
            >
              <For each={uiState.log}>
            {(commit, index) => {
              const initialExpanded = Boolean(index() < 2);
              const [isExpanded, setIsExpanded] = createSignal(initialExpanded);
              const [isCommitHovered, setIsCommitHovered] = createSignal(false);

              return (
                <div
                  style={{ 
                    background: "#252526", 
                    color: "#cccccc",
                    opacity: commit.isRemoteOnly ? "0.6" : "1",
                  }}
                  onMouseEnter={() => setIsCommitHovered(true)}
                  onMouseLeave={() => setIsCommitHovered(false)}
                >
                  <div
                    style={{
                      display: "flex",
                      "align-items": "center",
                      padding: "8px 12px",
                      cursor: "pointer",
                      background: isCommitHovered() ? "rgba(255, 255, 255, 0.05)" : "transparent",
                      "border-bottom": "1px solid #2d2d2d",
                    }}
                    onClick={() => setIsExpanded(!isExpanded())}
                  >
                    {/* Commit indicator circle */}
                    <div
                      style={{
                        width: "8px",
                        height: "8px",
                        "border-radius": "50%",
                        background: commit.isRemoteOnly ? "#858585" : "#0078d4",
                        "margin-right": "8px",
                        "flex-shrink": "0",
                      }}
                    />
                    
                    <div style={{ flex: "1", "min-width": "0" }}>
                      {/* Commit message */}
                      <div
                        style={{
                          color: "#cccccc",
                          "font-size": "13px",
                          "font-family": "'Segoe UI', system-ui, sans-serif",
                          "margin-bottom": "2px",
                          "white-space": "nowrap",
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                        }}
                      >
                        {commit.message.split('\n')[0]}
                      </div>
                      
                      {/* Author, date, and branch indicators */}
                      <div
                        style={{
                          display: "flex",
                          "align-items": "center",
                          gap: "8px",
                          color: "#858585",
                          "font-size": "11px",
                          "font-family": "'Segoe UI', system-ui, sans-serif",
                        }}
                      >
                        <span style={{ "white-space": "nowrap" }}>
                          {commit.author} • {new Intl.DateTimeFormat("en-US", {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "numeric",
                            hour12: true,
                          }).format(new Date(commit.date))}
                        </span>
                        
                        {/* Branch/Tag indicators - fade when hovering */}
                        <Show when={commit.refs && commit.refs.length > 0}>
                          <div style={{ 
                            display: "flex", 
                            gap: "4px", 
                            "flex-shrink": "0",
                            opacity: isCommitHovered() ? "0.1" : "1",
                          }}>
                            <For each={commit.refs}>
                              {(ref) => {
                                // Determine ref type and color
                                const isRemote = ref.includes('/');
                                const isHead = ref === uiState.branches.current;
                                
                                let bgColor = "#555";
                                let textColor = "#cccccc";
                                
                                if (isHead) {
                                  bgColor = "#ba7ddd";
                                  textColor = "#fff";
                                } else if (isRemote) {
                                  bgColor = "#0096ff";
                                  textColor = "#fff";
                                } else {
                                  bgColor = "#10b981";
                                  textColor = "#fff";
                                }
                                
                                return (
                                  <div
                                    style={{
                                      background: bgColor,
                                      color: textColor,
                                      "font-size": "10px",
                                      "font-weight": "600",
                                      padding: "2px 6px",
                                      "border-radius": "3px",
                                      "font-family": "'Segoe UI Mono', monospace",
                                      "white-space": "nowrap",
                                    }}
                                    title={isRemote ? 
                                      (uiState.syncStatus.ahead > 0 || uiState.syncStatus.behind > 0) ?
                                        `${ref} (common ancestor - this is where local and remote branches diverged)` :
                                        `Remote branch: ${ref}` :
                                      `Local branch: ${ref}`
                                    }
                                  >
                                    {isHead ? 'HEAD' : ref}
                                  </div>
                                );
                              }}
                            </For>
                          </div>
                        </Show>
                      </div>
                    </div>
                    
                    {/* Action buttons */}
                    <div style={{ 
                      display: "flex", 
                      gap: "4px", 
                      "margin-right": "8px",
                      opacity: isCommitHovered() ? "1" : "0",
                      transition: "opacity 0.2s ease",
                      position: "relative",
                      "z-index": "10",
                    }}>
                      {/* Undo button for latest LOCAL commit only */}
                      <Show when={!commit.isRemoteOnly && index() === uiState.log.findIndex(c => !c.isRemoteOnly)}>
                        <button
                          style={{
                            background: "#252526",
                            border: "1px solid #555",
                            color: "#cccccc",
                            "font-size": "10px",
                            padding: "2px 6px",
                            "border-radius": "3px",
                            cursor: "pointer",
                            "font-family": "'Segoe UI', system-ui, sans-serif",
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            undoLastCommit();
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.background = "#555"}
                          onMouseLeave={(e) => e.currentTarget.style.background = "#252526"}
                        >
                          Undo
                        </button>
                      </Show>
                      
                      {/* Checkout button for all commits */}
                      <button
                        style={{
                          background: "#252526",
                          border: "1px solid #555",
                          color: "#cccccc",
                          "font-size": "10px",
                          padding: "2px 6px",
                          "border-radius": "3px",
                          cursor: "pointer",
                          "font-family": "'Segoe UI', system-ui, sans-serif",
                        }}
                        onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            await electrobun.rpc?.request.gitCheckout({
                              repoRoot: repoRootPath,
                              hash: commit.hash,
                            });
                            await getLogAndStatus();
                          } catch (error) {
                            console.error('Checkout failed:', error);
                            showErrorDialog('Checkout Failed', error);
                          }
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = "#555"}
                        onMouseLeave={(e) => e.currentTarget.style.background = "#252526"}
                        title={`Checkout commit ${commit.hash.substring(0, 7)}`}
                      >
                        Checkout
                      </button>

                      {/* Revert button for all commits */}
                      <button
                        style={{
                          background: "#252526",
                          border: "1px solid #555",
                          color: "#cccccc",
                          "font-size": "10px",
                          padding: "2px 6px",
                          "border-radius": "3px",
                          cursor: "pointer",
                          "font-family": "'Segoe UI', system-ui, sans-serif",
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          softRevertCommit(commit);
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = "#555"}
                        onMouseLeave={(e) => e.currentTarget.style.background = "#252526"}
                      >
                        Revert
                      </button>
                    </div>
                    
                    {/* Remote commit indicator */}
                    <Show when={commit.isRemoteOnly}>
                      <div
                        style={{
                          display: "flex",
                          "align-items": "center",
                          "margin-right": "8px",
                          opacity: "0.7",
                        }}
                        title="Remote commit (from upstream)"
                      >
                        <svg 
                           width="14" 
                          height="14" 
                          viewBox="0 0 24 24" 
                          fill="none" 
                          style={{
                            color: "#858585",
                            "flex-shrink": "0",
                          }}
                        >
                          <path 
                            d="M9.00024 10.5001V15.0001M9.00024 15.0001H13.5002M9.00024 15.0001L15.0002 9M7.20024 20H16.8002C17.9203 20 18.4804 20 18.9082 19.782C19.2845 19.5903 19.5905 19.2843 19.7823 18.908C20.0002 18.4802 20.0002 17.9201 20.0002 16.8V7.2C20.0002 6.0799 20.0002 5.51984 19.7823 5.09202C19.5905 4.71569 19.2845 4.40973 18.9082 4.21799C18.4804 4 17.9203 4 16.8002 4H7.20024C6.08014 4 5.52009 4 5.09226 4.21799C4.71594 4.40973 4.40998 4.71569 4.21823 5.09202C4.00024 5.51984 4.00024 6.07989 4.00024 7.2V16.8C4.00024 17.9201 4.00024 18.4802 4.21823 18.908C4.40998 19.2843 4.71594 19.5903 5.09226 19.782C5.52009 20 6.08014 20 7.20024 20Z" 
                            stroke="currentColor" 
                            stroke-width="2" 
                            stroke-linecap="round" 
                            stroke-linejoin="round"
                          />
                        </svg>
                      </div>
                    </Show>
                    
                    {/* Expand/collapse arrow */}
                    <div
                      style={{
                        color: "#858585",
                        "font-size": "12px",
                        "margin-left": "8px",
                        transform: isExpanded() ? "rotate(90deg)" : "rotate(0deg)",
                        transition: "transform 0.15s ease",
                      }}
                    >
                      ▶
                    </div>
                  </div>
                  <Show when={isExpanded()}>
                    <div
                      style={{
                        background: "#1e1e1e",
                        "border-left": "3px solid #0078d4",
                        "margin-left": "20px",
                      }}
                    >
                      {/* Full commit message section */}
                      <div
                        style={{
                          padding: "12px",
                          "border-bottom": "1px solid #2d2d2d",
                          "margin-bottom": "4px",
                        }}
                      >
                        <div
                          style={{
                            color: "#cccccc",
                            "font-size": "11px",
                            "font-weight": "600",
                            "text-transform": "uppercase",
                            "letter-spacing": "0.5px",
                            "font-family": "'Segoe UI', system-ui, sans-serif",
                            "margin-bottom": "6px",
                          }}
                        >
                          COMMIT MESSAGE
                        </div>
                        <div
                          style={{
                            background: "#2d2d2d",
                            border: "1px solid #404040",
                            "border-radius": "3px",
                            padding: "8px 10px",
                            color: "#e0e0e0",
                            "font-size": "12px",
                            "font-family": "'Segoe UI', system-ui, sans-serif",
                            "line-height": "1.4",
                            "white-space": "pre-wrap",
                            "max-height": "120px",
                            "overflow-y": "auto",
                            "word-break": "break-word",
                          }}
                        >                          
                          {commit.body ? `${commit.message}\n\n${commit.body}` : commit.message}
                        </div>
                      </div>

                      {/* Files changed section */}
                      <For each={Object.entries(commit.files)}>
                        {([filepath, filechange]) => {
                          const dirname = filepath.substring(0, filepath.lastIndexOf('/')) || '';
                          const filename = filepath.substring(filepath.lastIndexOf('/') + 1);
                          
                          return (
                            <div
                              style={{
                                padding: "2px 12px",
                                cursor: "pointer",
                                display: "flex",
                                "align-items": "center",
                                "font-size": "12px",
                                "font-family": "'Segoe UI', system-ui, sans-serif",
                                color: "#cccccc",
                                "min-width": 0, // Allow flex item to shrink
                              }}
                              onClick={() => onClickChange(filechange, commit.hash)}
                            >
                              <ChangeTypeSpan changeType={filechange.changeType} />
                              <span style={{
                                display: "flex",
                                "align-items": "center",
                                "min-width": 0,
                                flex: "1",
                              }}>
                                <span style={{
                                  color: "#ffffff",
                                  "white-space": "nowrap",
                                }}>
                                  {filename}
                                </span>
                                <Show when={dirname}>
                                  <span style={{
                                    color: "#858585",
                                    "margin-left": "6px",
                                    "white-space": "nowrap",
                                    overflow: "hidden",
                                    "text-overflow": "ellipsis",
                                    "min-width": 0,
                                  }}>
                                    {dirname}
                                  </span>
                                </Show>
                              </span>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
          
          {/* Infinite Scroll - Load More Button */}
          <Show when={pagination.hasMore}>
            <div style={{
              display: "flex",
              "justify-content": "center",
              padding: "16px",
              "border-top": "1px solid #333",
            }}>
              <button
                onClick={loadMoreCommits}
                disabled={pagination.isLoading}
                style={{
                  background: pagination.isLoading ? "#333" : "#0969da",
                  border: "1px solid " + (pagination.isLoading ? "#555" : "#1f6feb"),
                  color: pagination.isLoading ? "#666" : "#ffffff",
                  "font-size": "12px",
                  padding: "8px 16px",
                  "border-radius": "6px",
                  cursor: pagination.isLoading ? "not-allowed" : "pointer",
                  "font-family": "'Segoe UI', system-ui, sans-serif",
                  display: "flex",
                  "align-items": "center",
                  gap: "6px",
                }}
                onMouseEnter={(e) => {
                  if (!pagination.isLoading) {
                    e.currentTarget.style.background = "#0860ca";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!pagination.isLoading) {
                    e.currentTarget.style.background = "#0969da";
                  }
                }}
              >
                <Show when={pagination.isLoading}>
                  <div style={{
                    width: "12px",
                    height: "12px",
                    border: "2px solid #666",
                    "border-top": "2px solid #ffffff",
                    "border-radius": "50%",
                    animation: "1s linear infinite spinner-rotate",
                  }}></div>
                </Show>
                {pagination.isLoading ? "Loading..." : "Load More Commits"}
              </button>
            </div>
          </Show>
          
          </div>
        </div>

        {/* Toggleable Section - Flex Item 4 */}
        <div style={{ 
          
          display: "flex", 
          "flex-direction": "column",
          overflow: "hidden"
        }}>
          {/* Toggle Header */}
          <div
            style={{
              background: "#1e1e1e",
              color: "#cccccc",
              padding: "8px 12px",
              "font-size": "11px",
              "font-weight": "600",
              "font-family": "'Segoe UI', system-ui, sans-serif",
              "border-bottom": "1px solid #2d2d2d",
              "flex-shrink": "0",
              display: "flex",
              "justify-content": "space-between",
              "align-items": "center",
            }}
          >
            <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
              <button
                style={{
                  background: uiState.activeSection === 'branches' ? "#094771" : "transparent",
                  border: "none",
                  color: "#cccccc",
                  "font-size": "11px",
                  "font-weight": "600",
                  "text-transform": "uppercase",
                  "letter-spacing": "0.5px",
                  padding: "4px 8px",
                  "border-radius": "3px",
                  cursor: "pointer",
                  "font-family": "'Segoe UI', system-ui, sans-serif",
                }}
                onClick={() => setUiState({ activeSection: 'branches' })}
              >
                BRANCHES ({uiState.branches?.all?.filter(b => !b.includes('remotes/')).length || 0})
              </button>
              <button
                style={{
                  background: uiState.activeSection === 'remotes' ? "#094771" : "transparent",
                  border: "none",
                  color: "#cccccc",
                  "font-size": "11px",
                  "font-weight": "600",
                  "text-transform": "uppercase",
                  "letter-spacing": "0.5px",
                  padding: "4px 8px",
                  "border-radius": "3px",
                  cursor: "pointer",
                  "font-family": "'Segoe UI', system-ui, sans-serif",
                }}
                onClick={() => setUiState({ activeSection: 'remotes' })}
              >
                REMOTES ({uiState.remotes?.length || 0})
              </button>
              <button
                style={{
                  background: uiState.activeSection === 'stashes' ? "#094771" : "transparent",
                  border: "none",
                  color: "#cccccc",
                  "font-size": "11px",
                  "font-weight": "600",
                  "text-transform": "uppercase",
                  "letter-spacing": "0.5px",
                  padding: "4px 8px",
                  "border-radius": "3px",
                  cursor: "pointer",
                  "font-family": "'Segoe UI', system-ui, sans-serif",
                }}
                onClick={() => setUiState({ activeSection: 'stashes' })}
              >
                STASHES ({uiState.stashes?.all?.length || 0})
              </button>
            </div>
          </div>
          <div
            style={{
              flex: "1",
              "min-height": "0",
              overflow: "auto",
              background: "#252526",
              color: "#cccccc",
            }}
          >
            {/* Branches Section */}
            <Show when={uiState.activeSection === 'branches'}>
              <div style={{ padding: "8px 0" }}>
                {/* Detached HEAD indicator */}
                <Show when={!uiState.branches.current || !uiState.branches.all.includes(uiState.branches.current)}>
                  <div style={{
                    padding: "8px 12px",
                    "border-bottom": "1px solid #2d2d2d",
                    background: "rgba(255, 165, 0, 0.1)",
                    "border-left": "3px solid #ffa500",
                    color: "#ffa500",
                    "font-size": "12px",
                    "font-family": "'Segoe UI', system-ui, sans-serif",
                  }}>
                    <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                      <div style={{ 
                        width: "8px", 
                        height: "8px", 
                        "border-radius": "50%", 
                        background: "#ffa500" 
                      }}></div>
                      <span style={{ "font-weight": "600" }}>DETACHED HEAD</span>
                    </div>
                    <Show when={uiState.branches.current}>
                      <div style={{ 
                        "margin-top": "4px", 
                        "font-size": "11px", 
                        color: "#cccccc",
                        "font-family": "monospace"
                      }}>
                        {uiState.branches.current.length > 12 ? 
                          uiState.branches.current.substring(0, 12) : 
                          uiState.branches.current
                        }
                      </div>
                    </Show>
                  </div>
                </Show>
                
                <Show
                  when={uiState.branches?.all?.filter(b => !b.includes('remotes/')).length > 0}
                  fallback={
                    <div style={{ padding: "12px", color: "#858585", "font-size": "12px" }}>
                      No local branches found
                    </div>
                  }
                >
                  <For each={uiState.branches.all.filter(b => !b.includes('remotes/'))}>
                    {(branch) => {
                      const isCurrent = branch === uiState.branches.current;
                      return (
                        <div
                          style={{
                            padding: "8px 12px",
                            display: "flex",
                            "align-items": "center",
                            "justify-content": "space-between",
                            "font-size": "13px",
                            "font-family": "'Segoe UI', system-ui, sans-serif",
                            background: isCurrent ? "rgba(9, 71, 113, 0.3)" : "transparent",
                            "border-left": isCurrent ? "3px solid #094771" : "3px solid transparent",
                            color: isCurrent ? "#4fc3f7" : "#cccccc",
                            "border-bottom": "1px solid #2d2d2d",
                          }}
                          onMouseEnter={(e) => !isCurrent && (e.currentTarget.style.background = "rgba(255, 255, 255, 0.05)")}
                          onMouseLeave={(e) => !isCurrent && (e.currentTarget.style.background = "transparent")}
                        >
                          <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                            <div style={{ 
                              width: "8px", 
                              height: "8px", 
                              "border-radius": "50%", 
                              background: isCurrent ? "#4fc3f7" : "#858585" 
                            }} />
                            <span style={{ "font-weight": isCurrent ? "600" : "normal" }}>
                              {branch}
                            </span>
                            {isCurrent && (
                              <span style={{ 
                                "font-size": "10px", 
                                color: "#858585", 
                                "font-weight": "normal" 
                              }}>
                                (current)
                              </span>
                            )}
                            {isCurrent && !uiState.branches.trackingBranch && (
                              <span style={{ 
                                "font-size": "10px", 
                                color: "#f59e0b", 
                                "font-weight": "normal" 
                              }}>
                                (local only)
                              </span>
                            )}
                          </div>
                          
                          <div style={{ display: "flex", gap: "4px", opacity: "0.8" }}>
                            <Show when={isCurrent && !uiState.branches.trackingBranch}>
                              <button
                                style={{
                                  background: "transparent",
                                  border: "1px solid #f59e0b",
                                  color: "#f59e0b",
                                  "font-size": "10px",
                                  padding: "2px 6px",
                                  "border-radius": "2px",
                                  cursor: "pointer",
                                }}
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  try {
                                    await electrobun.rpc?.request.gitPush({
                                      repoRoot: repoRootPath,
                                      remote: "origin",
                                      branch: branch,
                                      options: ["-u"], // Set upstream tracking
                                    });
                                    console.log('Branch published, refreshing status...');
                                    // Small delay to ensure git operation is fully committed
                                    await new Promise(resolve => setTimeout(resolve, 100));
                                    await getLogAndStatus();
                                    console.log('Status refreshed after publish');
                                  } catch (error) {
                                    console.error('Failed to publish branch:', error);
                                    alert(`Failed to publish branch: ${error}`);
                                  }
                                }}
                                onMouseEnter={(e) => { 
                                  e.currentTarget.style.background = "#f59e0b"; 
                                  e.currentTarget.style.color = "#000"; 
                                }}
                                onMouseLeave={(e) => { 
                                  e.currentTarget.style.background = "transparent"; 
                                  e.currentTarget.style.color = "#f59e0b"; 
                                }}
                              >
                                publish
                              </button>
                            </Show>
                            <Show when={!isCurrent}>
                              <button
                                style={{
                                  background: "transparent",
                                  border: "1px solid #555",
                                  color: "#cccccc",
                                  "font-size": "10px",
                                  padding: "2px 6px",
                                  "border-radius": "2px",
                                  cursor: "pointer",
                                }}
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  try {
                                    await electrobun.rpc?.request.gitCheckoutBranch({
                                      repoRoot: repoRootPath,
                                      branch: branch,
                                      options: [],
                                    });
                                    console.log('Branch checked out, refreshing status...');
                                    // Small delay to ensure git operation is fully committed
                                    await new Promise(resolve => setTimeout(resolve, 100));
                                    await getLogAndStatus();
                                    console.log('Status refreshed after checkout');
                                  } catch (error) {
                                    console.error('Failed to checkout branch:', error);
                                    showErrorDialog('Checkout Failed', error);
                                  }
                                }}
                                onMouseEnter={(e) => { e.currentTarget.style.background = "#555"; }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                              >
                                checkout
                              </button>
                              <button
                                style={{
                                  background: "transparent",
                                  border: "1px solid #d32f2f",
                                  color: "#f87171",
                                  "font-size": "10px",
                                  padding: "2px 6px",
                                  "border-radius": "2px",
                                  cursor: "pointer",
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDialogConfig({
                                    title: "Delete Branch",
                                    message: `Are you sure you want to delete the branch "${branch}"? This action cannot be undone.`,
                                    confirmText: "Delete",
                                    type: "danger",
                                    onConfirm: async () => {
                                      setDialogOpen(false);
                                      try {
                                        await electrobun.rpc?.request.gitDeleteBranch({
                                          repoRoot: repoRootPath,
                                          branchName: branch,
                                          options: []
                                        });
                                        await getLogAndStatus();
                                      } catch (error) {
                                        console.error('Failed to delete branch:', error);
                                        showErrorDialog('Delete Branch Failed', error);
                                      }
                                    },
                                  });
                                  setDialogOpen(true);
                                }}
                                onMouseEnter={(e) => { e.currentTarget.style.background = "#d32f2f"; e.currentTarget.style.color = "#fff"; }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#f87171"; }}
                              >
                                delete
                              </button>
                            </Show>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </Show>
                
                {/* New Branch Button / Input Form */}
                <div style={{ padding: "8px 12px", "border-top": "1px solid #2d2d2d" }}>
                  <Show when={!showBranchInput()} fallback={
                    <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
                      <input
                        type="text"
                        placeholder="Enter branch name..."
                        value={branchInputValue()}
                        onInput={(e) => setBranchInputValue(e.currentTarget.value)}
                        style={{
                          background: "#1e1e1e",
                          border: "1px solid #094771",
                          color: "#fff",
                          "font-size": "11px",
                          "font-family": "'Segoe UI', system-ui, sans-serif",
                          padding: "6px 8px",
                          "border-radius": "3px",
                          outline: "none",
                          width: "100%",
                          "box-sizing": "border-box"
                        }}
                        onFocus={(e) => { e.currentTarget.style.borderColor = "#4fc3f7"; }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = "#094771"; }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            const validation = validateBranchName(branchInputValue());
                            if (validation.isValid) {
                              handleCreateBranch();
                            }
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            setShowBranchInput(false);
                            setBranchInputValue("");
                          }
                        }}
                        ref={(el) => {
                          // Auto-focus when input appears
                          setTimeout(() => el?.focus(), 0);
                        }}
                      />
                      <Show when={branchInputValue().trim() && !validateBranchName(branchInputValue()).isValid}>
                        <div style={{
                          color: "#ff6b6b",
                          "font-size": "10px",
                          "font-family": "'Segoe UI', system-ui, sans-serif",
                          padding: "2px 0"
                        }}>
                          {validateBranchName(branchInputValue()).error}
                        </div>
                      </Show>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button
                          style={{
                            background: validateBranchName(branchInputValue()).isValid ? "#094771" : "#333",
                            border: "1px solid #094771",
                            color: validateBranchName(branchInputValue()).isValid ? "#fff" : "#999",
                            "font-size": "10px",
                            "font-weight": "600",
                            padding: "4px 8px",
                            "border-radius": "3px",
                            cursor: validateBranchName(branchInputValue()).isValid ? "pointer" : "not-allowed",
                            "font-family": "'Segoe UI', system-ui, sans-serif",
                            flex: 1
                          }}
                          onClick={handleCreateBranch}
                          disabled={!validateBranchName(branchInputValue()).isValid}
                        >
                          Create
                        </button>
                        <button
                          style={{
                            background: "transparent",
                            border: "1px solid #555",
                            color: "#ccc",
                            "font-size": "10px",
                            "font-weight": "600",
                            padding: "4px 8px",
                            "border-radius": "3px",
                            cursor: "pointer",
                            "font-family": "'Segoe UI', system-ui, sans-serif",
                            flex: 1
                          }}
                          onClick={() => {
                            setShowBranchInput(false);
                            setBranchInputValue("");
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  }>
                    <button
                      style={{
                        background: "transparent",
                        border: "1px solid #094771",
                        color: "#4fc3f7",
                        "font-size": "11px",
                        "font-weight": "600",
                        padding: "6px 12px",
                        "border-radius": "3px",
                        cursor: "pointer",
                        "font-family": "'Segoe UI', system-ui, sans-serif",
                        width: "100%",
                      }}
                      onClick={() => {
                        setShowBranchInput(true);
                        setBranchInputValue("");
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "#094771"; e.currentTarget.style.color = "#fff"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#4fc3f7"; }}
                    >
                      + New Branch
                    </button>
                  </Show>
                </div>
              </div>
            </Show>

            {/* Remotes Section */}
            <Show when={uiState.activeSection === 'remotes'}>
              <div>
                {/* Remote Actions Button Bar */}
                <div style={{ 
                  padding: "8px 12px", 
                  "border-bottom": "1px solid #2d2d2d",
                  display: "flex",
                  "justify-content": "flex-end",
                  "align-items": "center",
                  gap: "8px"
                }}>
                  <button
                    style={{
                      background: "transparent",
                      border: "1px solid #4fc3f7",
                      color: "#4fc3f7",
                      "font-size": "10px",
                      padding: "4px 8px",
                      "border-radius": "2px",
                      cursor: "pointer",
                      "font-family": "'Segoe UI', system-ui, sans-serif",
                    }}
                    onClick={() => {
                      setShowRemoteInput(true);
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "#4fc3f7";
                      e.currentTarget.style.color = "#000";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                      e.currentTarget.style.color = "#4fc3f7";
                    }}
                  >
                    + Add Remote
                  </button>
                </div>

                {/* Remote Input Form */}
                <Show when={showRemoteInput()}>
                  <div style={{
                    padding: "12px",
                    "border-bottom": "1px solid #2d2d2d",
                    background: "#1e1e1e"
                  }}>
                    <div style={{ "margin-bottom": "8px" }}>
                      <input
                        type="text"
                        placeholder="Remote name (e.g., origin)"
                        value={remoteNameValue()}
                        onInput={(e) => setRemoteNameValue(e.currentTarget.value)}
                        style={{
                          background: "#252526",
                          border: "1px solid #094771",
                          color: "#fff",
                          "font-size": "11px",
                          "font-family": "'Segoe UI', system-ui, sans-serif",
                          padding: "6px 8px",
                          "border-radius": "3px",
                          outline: "none",
                          width: "100%",
                          "box-sizing": "border-box",
                          "margin-bottom": "8px"
                        }}
                        onFocus={(e) => { e.currentTarget.style.borderColor = "#4fc3f7"; }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = "#094771"; }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            const nameValid = validateRemoteName(remoteNameValue()).isValid;
                            const urlValid = validateRemoteUrl(remoteUrlValue()).isValid;
                            if (nameValid && urlValid) {
                              handleAddRemote();
                            }
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            setShowRemoteInput(false);
                            setRemoteNameValue("");
                            setRemoteUrlValue("");
                          }
                        }}
                        ref={(el) => {
                          // Auto-focus when input appears
                          setTimeout(() => el?.focus(), 0);
                        }}
                      />
                      <Show when={remoteNameValue().trim() && !validateRemoteName(remoteNameValue()).isValid}>
                        <div style={{
                          color: "#ff6b6b",
                          "font-size": "10px",
                          "font-family": "'Segoe UI', system-ui, sans-serif",
                          padding: "2px 0 6px 0"
                        }}>
                          {validateRemoteName(remoteNameValue()).error}
                        </div>
                      </Show>
                      <input
                        type="text"
                        placeholder="Remote URL (e.g., https://github.com/user/repo.git)"
                        value={remoteUrlValue()}
                        onInput={(e) => setRemoteUrlValue(e.currentTarget.value)}
                        style={{
                          background: "#252526",
                          border: "1px solid #094771",
                          color: "#fff",
                          "font-size": "11px",
                          "font-family": "'Segoe UI', system-ui, sans-serif",
                          padding: "6px 8px",
                          "border-radius": "3px",
                          outline: "none",
                          width: "100%",
                          "box-sizing": "border-box"
                        }}
                        onFocus={(e) => { e.currentTarget.style.borderColor = "#4fc3f7"; }}
                        onBlur={(e) => { e.currentTarget.style.borderColor = "#094771"; }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            const nameValid = validateRemoteName(remoteNameValue()).isValid;
                            const urlValid = validateRemoteUrl(remoteUrlValue()).isValid;
                            if (nameValid && urlValid) {
                              handleAddRemote();
                            }
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            setShowRemoteInput(false);
                            setRemoteNameValue("");
                            setRemoteUrlValue("");
                          }
                        }}
                      />
                      <Show when={remoteUrlValue().trim() && !validateRemoteUrl(remoteUrlValue()).isValid}>
                        <div style={{
                          color: "#ff6b6b",
                          "font-size": "10px",
                          "font-family": "'Segoe UI', system-ui, sans-serif",
                          padding: "2px 0"
                        }}>
                          {validateRemoteUrl(remoteUrlValue()).error}
                        </div>
                      </Show>
                    </div>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <button
                        style={{
                          background: (validateRemoteName(remoteNameValue()).isValid && validateRemoteUrl(remoteUrlValue()).isValid) ? "#094771" : "#333",
                          border: "1px solid #094771",
                          color: (validateRemoteName(remoteNameValue()).isValid && validateRemoteUrl(remoteUrlValue()).isValid) ? "#fff" : "#999",
                          "font-size": "10px",
                          "font-weight": "600",
                          padding: "4px 8px",
                          "border-radius": "3px",
                          cursor: (validateRemoteName(remoteNameValue()).isValid && validateRemoteUrl(remoteUrlValue()).isValid) ? "pointer" : "not-allowed",
                          "font-family": "'Segoe UI', system-ui, sans-serif",
                          flex: 1
                        }}
                        onClick={handleAddRemote}
                        disabled={!(validateRemoteName(remoteNameValue()).isValid && validateRemoteUrl(remoteUrlValue()).isValid)}
                      >
                        Add
                      </button>
                      <button
                        style={{
                          background: "transparent",
                          border: "1px solid #555",
                          color: "#ccc",
                          "font-size": "10px",
                          "font-weight": "600",
                          padding: "4px 8px",
                          "border-radius": "3px",
                          cursor: "pointer",
                          "font-family": "'Segoe UI', system-ui, sans-serif",
                          flex: 1
                        }}
                        onClick={() => {
                          setShowRemoteInput(false);
                          setRemoteNameValue("");
                          setRemoteUrlValue("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </Show>

                <Show
                  when={uiState.remotes?.length > 0}
                  fallback={
                    <div style={{ padding: "12px", color: "#858585", "font-size": "12px" }}>
                      No remotes configured
                    </div>
                  }
                >
                  <For each={uiState.remotes}>
                    {(remote) => {
                      const isExpanded = () => expandedRemotes().has(remote.name);
                      return (
                        <div style={{ "border-bottom": "1px solid #2d2d2d" }}>
                          <div
                            style={{
                              padding: "8px 12px",
                              cursor: "pointer",
                              display: "flex",
                              "align-items": "center",
                              "font-size": "13px",
                              "font-family": "'Segoe UI', system-ui, sans-serif",
                            }}
                            onClick={() => {
                              const newExpanded = new Set(expandedRemotes());
                              if (isExpanded()) {
                                newExpanded.delete(remote.name);
                              } else {
                                newExpanded.add(remote.name);
                              }
                              setExpandedRemotes(newExpanded);
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255, 255, 255, 0.05)"}
                            onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                          >
                            <div
                              style={{
                                color: "#858585",
                                "font-size": "12px",
                                "margin-right": "8px",
                                transform: isExpanded() ? "rotate(90deg)" : "rotate(0deg)",
                                transition: "transform 0.15s ease",
                              }}
                            >
                              ▶
                            </div>
                            <span style={{ "font-weight": "600" }}>{remote.name}</span>
                            <span style={{ color: "#858585", "margin-left": "8px", "font-size": "11px" }}>
                              {remote.refs?.fetch || remote.refs?.push || ""}
                            </span>
                          </div>
                          <Show when={isExpanded()}>
                          <div style={{ "padding-left": "32px", background: "#1e1e1e" }}>
                            <For each={uiState.branches.remote.filter((b: string) => b.includes(`remotes/${remote.name}/`))}>
                              {(branch) => {
                                const branchName = branch.replace(`remotes/${remote.name}/`, '');
                                const isCurrent = branchName === uiState.branches.current;
                                return (
                                  <div
                                    style={{
                                      padding: "4px 12px",
                                      display: "flex",
                                      "align-items": "center",
                                      "justify-content": "space-between",
                                      "font-size": "12px",
                                      color: isCurrent ? "#0078d4" : "#cccccc",
                                    }}
                                    onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255, 255, 255, 0.05)"}
                                    onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                                  >
                                    <span>{branchName}</span>
                                    <Show when={!isCurrent}>
                                      {(() => {
                                        const hasLocalBranch = uiState.branches.all.includes(branchName);
                                        const buttonText = hasLocalBranch ? "switch" : "track";
                                        const borderColor = hasLocalBranch ? "#555" : "#4fc3f7";
                                        const textColor = hasLocalBranch ? "#cccccc" : "#4fc3f7";
                                        
                                        return (
                                          <button
                                            style={{
                                              background: "transparent",
                                              border: `1px solid ${borderColor}`,
                                              color: textColor,
                                              "font-size": "10px",
                                              padding: "2px 6px",
                                              "border-radius": "2px",
                                              cursor: "pointer",
                                              opacity: "0.7",
                                            }}
                                            onClick={async (e) => {
                                              e.stopPropagation();
                                              try {
                                                if (hasLocalBranch) {
                                                  // Switch to existing local tracking branch
                                                  await electrobun.rpc?.request.gitCheckoutBranch({
                                                    repoRoot: repoRootPath,
                                                    branch: branchName,
                                                    options: [],
                                                  });
                                                  console.log('Switched to local tracking branch, refreshing status...');
                                                } else {
                                                  // Create and checkout a new local branch tracking the remote
                                                  await electrobun.rpc?.request.gitTrackRemoteBranch({
                                                    repoRoot: repoRootPath,
                                                    branchName: branchName,
                                                    remoteName: remote.name,
                                                  });
                                                  console.log('Created tracking branch, refreshing status...');
                                                }
                                                
                                                // Small delay to ensure git operation is fully committed
                                                await new Promise(resolve => setTimeout(resolve, 100));
                                                await getLogAndStatus();
                                                console.log('Status refreshed after branch operation');
                                              } catch (error) {
                                                console.error(`Failed to ${buttonText} branch:`, error);
                                                showErrorDialog(`${buttonText.charAt(0).toUpperCase() + buttonText.slice(1)} Failed`, error);
                                              }
                                            }}
                                            onMouseEnter={(e) => { 
                                              e.currentTarget.style.opacity = "1"; 
                                              e.currentTarget.style.background = hasLocalBranch ? "#555" : "#4fc3f7";
                                              if (!hasLocalBranch) e.currentTarget.style.color = "#fff";
                                            }}
                                            onMouseLeave={(e) => { 
                                              e.currentTarget.style.opacity = "0.7"; 
                                              e.currentTarget.style.background = "transparent";
                                              e.currentTarget.style.color = textColor;
                                            }}
                                          >
                                            {buttonText}
                                          </button>
                                        );
                                      })()}
                                    </Show>
                                  </div>
                                );
                              }}
                            </For>
                          </div>
                        </Show>
                        </div>
                      );
                    }}
                  </For>
                </Show>
              </div>
            </Show>

            {/* Stashes Section */}
            <Show when={uiState.activeSection === 'stashes'}>
              <div>
                {/* Stash Actions Button Bar */}
                <div style={{ 
                  padding: "8px 12px", 
                  "border-bottom": "1px solid #2d2d2d",
                  display: "flex",
                  "justify-content": "flex-end",
                  "align-items": "center",
                  gap: "8px"
                }}>
                  <button
                    style={{
                      background: "transparent",
                      border: "1px solid #4fc3f7",
                      color: "#4fc3f7",
                      "font-size": "10px",
                      padding: "4px 8px",
                      "border-radius": "2px",
                      cursor: "pointer",
                      "font-family": "'Segoe UI', system-ui, sans-serif",
                    }}
                    onClick={() => setShowStashForm(!showStashForm())}
                    onMouseEnter={(e) => { 
                      e.currentTarget.style.background = "#4fc3f7"; 
                      e.currentTarget.style.color = "#000"; 
                    }}
                    onMouseLeave={(e) => { 
                      e.currentTarget.style.background = "transparent"; 
                      e.currentTarget.style.color = "#4fc3f7"; 
                    }}
                    title="Create new stash"
                  >
                    + New Stash
                  </button>
                </div>
                
                {/* Stash Creation Form */}
                <Show when={showStashForm()}>
              <div style={{ padding: "12px", "border-bottom": "1px solid #2d2d2d", background: "#1e1e1e" }}>
                <div style={{ "margin-bottom": "8px" }}>
                  <label style={{ 
                    color: "#cccccc", 
                    "font-size": "11px", 
                    "font-weight": "600",
                    "font-family": "'Segoe UI', system-ui, sans-serif",
                    display: "block",
                    "margin-bottom": "4px"
                  }}>
                    STASH MESSAGE
                  </label>
                  <input
                    type="text"
                    placeholder="Describe your stash..."
                    value={stashMessage()}
                    onInput={(e) => setStashMessage(e.currentTarget.value)}
                    style={{
                      width: "100%",
                      background: "#3c3c3c",
                      border: "1px solid #464647",
                      "border-radius": "2px",
                      color: "#cccccc",
                      outline: "none",
                      "font-family": "'Segoe UI', system-ui, sans-serif",
                      "font-size": "12px",
                      padding: "6px 8px",
                      "box-sizing": "border-box",
                    }}
                  />
                </div>
                
                <div style={{ "margin-bottom": "12px" }}>
                  <label style={{
                    display: "flex",
                    "align-items": "center",
                    color: "#cccccc",
                    "font-size": "11px",
                    "font-family": "'Segoe UI', system-ui, sans-serif",
                    cursor: "pointer",
                  }}>
                    <input
                      type="checkbox"
                      checked={includeUntracked()}
                      onChange={(e) => setIncludeUntracked(e.currentTarget.checked)}
                      style={{
                        "margin-right": "6px",
                        "accent-color": "#0078d4",
                      }}
                    />
                    Include untracked files
                  </label>
                </div>

                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    onClick={createStash}
                    style={{
                      background: "#0e639c",
                      border: "none",
                      "border-radius": "2px",
                      color: "#ffffff",
                      cursor: "pointer",
                      "font-family": "'Segoe UI', system-ui, sans-serif",
                      "font-size": "11px",
                      padding: "6px 12px",
                      flex: "1",
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = "#1177bb"}
                    onMouseLeave={(e) => e.currentTarget.style.background = "#0e639c"}
                  >
                    Save Stash
                  </button>
                  <button
                    onClick={() => setShowStashForm(false)}
                    style={{
                      background: "transparent",
                      border: "1px solid #555",
                      "border-radius": "2px",
                      color: "#cccccc",
                      cursor: "pointer",
                      "font-family": "'Segoe UI', system-ui, sans-serif",
                      "font-size": "11px",
                      padding: "6px 12px",
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = "#555"}
                    onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </Show>

            {/* Debug: Show stash count */}
            <div style={{ padding: "4px 12px", color: "#ff0", "font-size": "10px" }}>
            </div>

            {/* Stash List */}
            <Show 
              when={uiState.stashes?.all?.length > 0}
              fallback={
                <Show when={!showStashForm()}>
                  <div style={{ padding: "12px", color: "#858585", "font-size": "12px" }}>
                    No stashes yet
                  </div>
                </Show>
              }
            >
              <For each={uiState.stashes?.all || []}>
                {(stash, index) => {
                  const stashName = `stash@{${index()}}`;
                  const isExpanded = () => expandedStashes().has(stashName);
                  
                  return (
                  <div style={{ "border-bottom": "1px solid #2d2d2d" }}>
                    <div
                      style={{
                        padding: "8px 12px",
                        cursor: "pointer",
                      }}
                      onClick={() => {
                        const newExpanded = new Set(expandedStashes());
                        if (isExpanded()) {
                          newExpanded.delete(stashName);
                        } else {
                          newExpanded.add(stashName);
                          // Fetch files when expanding for the first time
                          if (!stashFiles()[stashName]) {
                            fetchStashFiles(stashName);
                          }
                        }
                        setExpandedStashes(newExpanded);
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255, 255, 255, 0.05)"}
                      onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                    >
                    <div style={{ 
                      display: "flex", 
                      "justify-content": "space-between",
                      "align-items": "center"
                    }}>
                      <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                        <div style={{ 
                          width: "12px", 
                          height: "12px", 
                          display: "flex", 
                          "align-items": "center", 
                          "justify-content": "center",
                          color: "#858585",
                          "font-size": "10px",
                          transform: isExpanded() ? "rotate(90deg)" : "rotate(0deg)",
                          transition: "transform 0.2s ease"
                        }}>
                          ▶
                        </div>
                        <div>
                          <div style={{ 
                            "font-size": "12px", 
                            "margin-bottom": "2px",
                            color: "#cccccc"
                          }}>
                            {stash.message || stashName}
                          </div>
                          <div style={{ 
                            "font-size": "10px", 
                            color: "#858585"
                          }}>
                            {new Intl.DateTimeFormat("en-US", {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "numeric",
                              hour12: true,
                            }).format(new Date(stash.date))}
                          </div>
                        </div>
                      </div>
                      
                      <div style={{ display: "flex", gap: "4px" }}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            applyStash(stashName);
                          }}
                          style={{
                            background: "transparent",
                            border: "1px solid #555",
                            color: "#cccccc",
                            "font-size": "10px",
                            padding: "2px 6px",
                            "border-radius": "2px",
                            cursor: "pointer",
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.background = "#555"}
                          onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                        >
                          Apply
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            dropStash(stashName);
                          }}
                          style={{
                            background: "transparent",
                            border: "1px solid #555",
                            color: "#cccccc",
                            "font-size": "10px",
                            padding: "2px 6px",
                            "border-radius": "2px",
                            cursor: "pointer",
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.background = "#555"}
                          onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    </div>
                    
                    {/* Expandable file list */}
                    <Show when={isExpanded()}>
                      <div style={{ padding: "0 12px 8px 32px" }}>
                        <Show 
                          when={stashFiles()[stashName]?.length > 0}
                          fallback={
                            <div style={{ 
                              color: "#858585", 
                              "font-size": "11px", 
                              "font-style": "italic",
                              padding: "4px 0"
                            }}>
                              Loading files...
                            </div>
                          }
                        >
                          <For each={stashFiles()[stashName] || []}>
                            {(file) => (
                              <div
                                style={{
                                  padding: "2px 0",
                                  cursor: "pointer",
                                  display: "flex",
                                  "align-items": "center",
                                  gap: "8px",
                                  "font-size": "11px",
                                }}
                                onClick={() => {
                                  // Set selected file to show stash diff
                                  setSelectedFile({
                                    relPath: file.relPath,
                                    changeType: file.changeType,
                                    commitHash: stashName,
                                    isFromStaged: false,
                                  });
                                }}
                                onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255, 255, 255, 0.05)"}
                                onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                              >
                                <span style={{
                                  display: "inline-block",
                                  width: "15px",
                                  "text-align": "center",
                                  "font-family": "monospace",
                                  "font-weight": "bold",
                                  color: file.changeType === 'A' ? "#44987e" : 
                                        file.changeType === 'M' ? "#d19a66" : 
                                        file.changeType === 'D' ? "#e06c75" : "#cccccc"
                                }}>
                                  {file.changeType}
                                </span>
                                <span style={{ color: "#cccccc" }}>
                                  {file.relPath}
                                </span>
                              </div>
                            )}
                          </For>
                        </Show>
                      </div>
                    </Show>
                  </div>
                  );
                }}
              </For>
            </Show>
              </div>
            </Show>{/* End of Stashes Section */}
          </div>
        </div>
      </div>
      </div>
      <div id="backup-diff" style={{ height: "100%", width: "100%" }}>
        <Show 
          when={`${selectedFile().relPath}-${selectedFile().isFromStaged ? 'staged' : 'unstaged'}`}
          keyed
          fallback={<div>Loading...</div>}
        >
          <DiffEditor
            originalText={() => uiState.originalText || ""}
            modifiedText={() => uiState.modifiedText || ""}
            onStageLines={stageLines}
            onUnstageLines={unstageLines}
            canStageLines={(() => {
              const canStage = selectedFile().commitHash === "HEAD";
              console.log("GitSlate: canStageLines =", canStage, "commitHash =", selectedFile().commitHash);
              return canStage;
            })()}
            filePath={(() => {
              const path = selectedFile().relPath;
              console.log("GitSlate: filePath =", path);
              return path;
            })()}
            isStaged={(() => {
              const staged = selectedFile().isFromStaged || false;
              console.log("GitSlate: passing isStaged =", staged, "to DiffEditor");
              return staged;
            })()}
          />
        </Show>
      </div>
      
      {/* Dialog Component */}
      {(() => {
        console.log('About to render Dialog - isOpen:', dialogOpen(), 'title:', dialogConfig().title);
        return (
          <Dialog
            isOpen={dialogOpen}
            title={dialogConfig().title}
            message={dialogConfig().message}
            onConfirm={dialogConfig().onConfirm}
            onCancel={() => setDialogOpen(false)}
            confirmText={dialogConfig().confirmText}
            type={dialogConfig().type}
          />
        );
      })()}
    </div>
  );
};

const changeTypeStyles = (changeType: string) => {
  switch (changeType) {
    case "A":
      return {
        background: "#44987e",
        // color: '#fff',
      };
    case "M":
      return {
        background: "#4886f8",
        // color: '#fff',
      };
    case "D":
      return {
        background: "#b4432a",
        // color: '#fff',
      };
    case "R":
      return {
        background: "#df893c",
        // color: '#fff',
      };
    case "?":
      return {
        background: "#8a5cf5", // Purple for untracked
        // color: '#fff',
      };
    default:
      return {
        background: "#666", // Gray for unknown statuses
      };
  }
};

const ChangeTypeSpan = ({
  changeType,
}: {
  changeType: FileChangeType["changeType"];
}) => {
  const styles = changeTypeStyles(changeType);
  
  // Get display label and tooltip for different change types
  const getChangeInfo = (type: string) => {
    switch (type) {
      case "A":
        return { label: "A", tooltip: "Added" };
      case "M":
        return { label: "M", tooltip: "Modified" };
      case "D":
        return { label: "D", tooltip: "Deleted" };
      case "R":
        return { label: "R", tooltip: "Renamed" };
      case "?":
        return { label: "U", tooltip: "Untracked" }; // Use "U" for better visibility
      default:
        return { label: type || "?", tooltip: "Unknown status" };
    }
  };
  
  const { label, tooltip } = getChangeInfo(changeType);

  return (
    <span
      style={{
        ...styles,
        color: "#fff",
        padding: "3px",
        margin: "0 5px",
        "font-size": "11px",
        "font-weight": "bold",
        "font-family": "sans-serif",
        width: "11px",
        height: "11px",
        display: "inline-block",
        "text-align": "center",
      }}
      title={tooltip}
    >
      {label}
    </span>
  );
};

const filesAsChanges = (files: FileChangesType = {}) => {
  return Object.keys(files).map((relPath) => {
    return files[relPath];
  });
};

const FileList = ({
  files,
  commitHash,
  onClick,
  selectedFile,
  showStageButtons = false,
  onStage,
  onUnstage,
  onDiscard,
  isStaged = false,
  repoRootPath,
}: {
  files: Accessor<FileChangesType>;
  commitHash: string;
  onClick: (change: FileChangeType, commitHash: string) => void;
  selectedFile: Accessor<FileChangeWithCommitType>;
  showStageButtons?: boolean;
  onStage?: (filePath: string) => void;
  onUnstage?: (filePath: string) => void;
  onDiscard?: (filePath: string) => void;
  isStaged?: boolean;
  repoRootPath: string;
}) => {
  return (
    <div class="file-list" style={{ margin: "10px 0" }}>
      <For each={filesAsChanges(files())}>
        {(change) => (
          <FileListItem
            change={change}
            commitHash={commitHash}
            onClick={onClick}
            selectedFile={selectedFile}
            showStageButtons={showStageButtons}
            onStage={onStage}
            onUnstage={onUnstage}
            onDiscard={onDiscard}
            isStaged={isStaged}
            repoRootPath={repoRootPath}
          />
        )}
      </For>
    </div>
  );
};

const FileListItem = ({
  change,
  commitHash,
  onClick,
  selectedFile,
  showStageButtons = false,
  onStage,
  onUnstage,
  onDiscard,
  isStaged = false,
  repoRootPath,
}: {
  change: FileChangeType;
  commitHash: string;
  onClick: (change: FileChangeType, commitHash: string) => void;
  selectedFile: Accessor<FileChangeWithCommitType>;
  showStageButtons?: boolean;
  onStage?: (filePath: string) => void;
  onUnstage?: (filePath: string) => void;
  onDiscard?: (filePath: string) => void;
  isStaged?: boolean;
  repoRootPath: string;
}) => {
  const [isHovered, setIsHovered] = createSignal(false);
  const isSelected = () =>
    commitHash === selectedFile().commitHash &&
    change.relPath === selectedFile().relPath &&
    isStaged === selectedFile().isFromStaged;
  const backgroundStyle = () => {
    if (isSelected()) {
      return "#094771";
    }
    return isHovered() ? "rgba(255, 255, 255, 0.05)" : "transparent";
  };

  const handleStageClick = (e: Event) => {
    e.stopPropagation();
    if (isStaged && onUnstage) {
      onUnstage(change.relPath);
    } else if (!isStaged && onStage) {
      onStage(change.relPath);
    }
  };

  const handleDoubleClick = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    
    // Construct full file path from repo root and relative path
    const fullPath = change.relPath.startsWith('/') 
      ? change.relPath 
      : `${repoRootPath}/${change.relPath}`;
    
    openNewTabForNode(fullPath, false, { focusNewTab: true });
  };

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        display: "flex",
        "align-items": "center",
        "justify-content": "space-between",
        background: backgroundStyle(),
        color: "#cccccc",
        "font-size": "13px",
        padding: "2px 8px",
        "min-height": "22px",
        "font-family": "'Segoe UI', 'SF Pro Display', system-ui, sans-serif",
      }}
    >
      <div
        onClick={() => onClick(change, commitHash)}
        onDblClick={handleDoubleClick}
        style={{
          cursor: "pointer",
          display: "flex",
          "align-items": "center",
          flex: "1",
          "min-width": 0, // Allow flex item to shrink below content size
        }}
      >
        <ChangeTypeSpan changeType={change.changeType} />
        <span style={{
          display: "flex",
          "align-items": "center",
          "min-width": 0, // Allow span to shrink
          flex: "1",
        }}>
          <span style={{
            color: "#ffffff",
            "white-space": "nowrap",
          }}>
            {change.relPath.split('/').pop()}
          </span>
          <Show when={change.relPath.includes('/')}>
            <span style={{
              color: "#858585",
              "margin-left": "6px",
              "white-space": "nowrap",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "min-width": 0,
            }}>
              {change.relPath.substring(0, change.relPath.lastIndexOf('/'))}
            </span>
          </Show>
        </span>
      </div>
      
      <Show when={showStageButtons}>
        <div style={{ display: "flex", "align-items": "center", "margin-left": "auto" }}>
          <Show when={!isStaged && onDiscard}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDiscard?.(change.relPath);
              }}
              style={{
                background: "transparent",
                color: "#8a8a8a",
                border: "none",
                "border-radius": "2px",
                width: "20px",
                height: "20px",
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                cursor: "pointer",
                "margin-right": "4px",
                "font-size": "14px",
                "font-weight": "400",
                transition: "all 0.15s ease",
                "line-height": "1",
                opacity: isHovered() ? "1" : "0",
              }}
              title="Discard changes"
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "#ffffff";
                e.currentTarget.style.background = "rgba(255, 255, 255, 0.1)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "#8a8a8a";
                e.currentTarget.style.background = "transparent";
              }}
            >
              <svg 
                xmlns="http://www.w3.org/2000/svg" 
                width="16" 
                height="16" 
                viewBox="0 0 24 24" 
                fill="none"
                style={{ display: "block" }}
              >
                <path 
                  d="M10 8H5V3M5.29102 16.3569C6.22284 17.7918 7.59014 18.8902 9.19218 19.4907C10.7942 20.0913 12.547 20.1624 14.1925 19.6937C15.8379 19.225 17.2893 18.2413 18.3344 16.8867C19.3795 15.5321 19.963 13.878 19.9989 12.1675C20.0347 10.4569 19.5211 8.78001 18.5337 7.38281C17.5462 5.98561 16.1366 4.942 14.5122 4.40479C12.8878 3.86757 11.1341 3.86499 9.5083 4.39795C7.88252 4.93091 6.47059 5.97095 5.47949 7.36556" 
                  stroke="currentColor" 
                  stroke-width="2" 
                  stroke-linecap="round" 
                  stroke-linejoin="round"
                />
              </svg>
            </button>
          </Show>
          <button
            onClick={handleStageClick}
            style={{
              background: "transparent",
              color: "#8a8a8a",
              border: "none",
              "border-radius": "2px",
              width: "20px",
              height: "20px",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              cursor: "pointer",
              "margin-right": "8px",
              "font-size": "14px",
              "font-weight": "400",
              transition: "all 0.15s ease",
              "line-height": "1",
              opacity: isHovered() ? "1" : "0",
            }}
            title={isStaged ? "Unstage file" : "Stage file"}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "#ffffff";
              e.currentTarget.style.background = "rgba(255, 255, 255, 0.1)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "#8a8a8a";
              e.currentTarget.style.background = "transparent";
            }}
          >
            {isStaged ? "−" : "+"}
          </button>
        </div>
      </Show>
    </div>
  );
};

