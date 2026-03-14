import {
  checkGitHubCredentials,
  getGitConfig,
  gitAdd,
  gitAddRemote,
  gitApply,
  gitBranch,
  gitCheckout,
  gitCheckoutBranch,
  gitCheckIsRepoInTree,
  gitCheckIsRepoRoot,
  gitClone,
  gitCommit,
  gitCommitAmend,
  gitCreateBranch,
  gitCreatePatchFromLines,
  gitDeleteBranch,
  gitDiff,
  gitFetch,
  gitLog,
  gitLogRemoteOnly,
  gitPull,
  gitPush,
  gitRemote,
  gitReset,
  gitRevert,
  gitRevParse,
  gitShow,
  gitStageHunkFromPatch,
  gitStageMonacoChange,
  gitStageSpecificLines,
  gitStashApply,
  gitStashCreate,
  gitStashList,
  gitStashPop,
  gitStashShow,
  gitStatus,
  gitTrackRemoteBranch,
  gitUnstageMonacoChange,
  gitValidateUrl,
  initGit,
  removeGitHubCredentials,
  setGitConfig,
  storeGitHubCredentials,
} from "./gitUtils";

type RequestMessage = {
  type?: string;
  requestId?: number;
  method?: string;
  params?: any;
};

function postResponse(requestId: number | undefined, success: boolean, payload?: unknown, error?: string) {
  const normalizedPayload =
    payload === undefined
      ? undefined
      : payload === null || typeof payload === "string" || typeof payload === "number" || typeof payload === "boolean"
        ? payload
        : JSON.parse(JSON.stringify(payload));

  self.postMessage({
    type: "response",
    requestId,
    success,
    payload: normalizedPayload,
    error,
  });
}

async function handleRequest(method: string, params: any) {
  switch (method) {
    case "gitShow":
      return gitShow(String(params?.repoRoot || ""), Array.isArray(params?.options) ? params.options.map(String) : []);
    case "gitCommit":
      return gitCommit(String(params?.repoRoot || ""), String(params?.msg || ""));
    case "gitCommitAmend":
      return gitCommitAmend(String(params?.repoRoot || ""), String(params?.msg || ""));
    case "gitAdd":
      return gitAdd(
        String(params?.repoRoot || ""),
        Array.isArray(params?.files) ? params.files.map(String) : String(params?.files || ""),
      );
    case "gitLog":
      return gitLog(
        String(params?.repoRoot || ""),
        Array.isArray(params?.options) ? params.options.map(String) : [],
        typeof params?.limit === "number" ? params.limit : undefined,
        typeof params?.skip === "number" ? params.skip : undefined,
      );
    case "gitStatus":
      return gitStatus(String(params?.repoRoot || ""));
    case "gitDiff":
      return gitDiff(String(params?.repoRoot || ""), Array.isArray(params?.options) ? params.options.map(String) : []);
    case "gitCheckout":
      return gitCheckout(String(params?.repoRoot || ""), String(params?.hash || ""));
    case "gitCheckIsRepoRoot":
      return gitCheckIsRepoRoot(String(params?.repoRoot || ""));
    case "gitCheckIsRepoInTree":
      return gitCheckIsRepoInTree(String(params?.repoRoot || ""));
    case "gitRevParse":
      return gitRevParse(String(params?.repoRoot || ""), Array.isArray(params?.options) ? params.options.map(String) : []);
    case "gitReset":
      return gitReset(String(params?.repoRoot || ""), Array.isArray(params?.options) ? params.options.map(String) : []);
    case "gitRevert":
      return gitRevert(
        String(params?.repoRoot || ""),
        String(params?.commitHash || ""),
        Array.isArray(params?.options) ? params.options.map(String) : [],
      );
    case "gitApply":
      return gitApply(
        String(params?.repoRoot || ""),
        Array.isArray(params?.options) ? params.options.map(String) : [],
        typeof params?.patch === "string" ? params.patch : undefined,
      );
    case "gitStageHunkFromPatch":
      return gitStageHunkFromPatch(String(params?.repoRoot || ""), String(params?.patch || ""));
    case "gitStageSpecificLines":
      return gitStageSpecificLines(
        String(params?.repoRoot || ""),
        String(params?.filePath || ""),
        Number(params?.startLine || 0),
        Number(params?.endLine || 0),
      );
    case "gitStageMonacoChange":
      return gitStageMonacoChange(
        String(params?.repoRoot || ""),
        String(params?.filePath || ""),
        String(params?.originalContent || ""),
        params?.targetChange,
        String(params?.modifiedContent || ""),
      );
    case "gitUnstageMonacoChange":
      return gitUnstageMonacoChange(
        String(params?.repoRoot || ""),
        String(params?.filePath || ""),
        String(params?.originalContent || ""),
        params?.targetChange,
        String(params?.stagedContent || ""),
      );
    case "gitCreatePatchFromLines":
      return gitCreatePatchFromLines(
        String(params?.repoRoot || ""),
        String(params?.filePath || ""),
        Number(params?.startLine || 0),
        Number(params?.endLine || 0),
      );
    case "gitStashList":
      return gitStashList(String(params?.repoRoot || ""));
    case "gitStashCreate":
      return gitStashCreate(
        String(params?.repoRoot || ""),
        typeof params?.message === "string" ? params.message : undefined,
        Array.isArray(params?.options) ? params.options.map(String) : [],
      );
    case "gitStashApply":
      return gitStashApply(String(params?.repoRoot || ""), String(params?.stashName || ""));
    case "gitStashPop":
      return gitStashPop(String(params?.repoRoot || ""), String(params?.stashName || ""));
    case "gitStashShow":
      return gitStashShow(String(params?.repoRoot || ""), String(params?.stashName || ""));
    case "gitRemote":
      return gitRemote(String(params?.repoRoot || ""));
    case "gitAddRemote":
      return gitAddRemote(
        String(params?.repoRoot || ""),
        String(params?.remoteName || ""),
        String(params?.remoteUrl || ""),
      );
    case "gitFetch":
      return gitFetch(
        String(params?.repoRoot || ""),
        typeof params?.remote === "string" ? params.remote : undefined,
        Array.isArray(params?.options) ? params.options.map(String) : [],
      );
    case "gitPull":
      return gitPull(
        String(params?.repoRoot || ""),
        typeof params?.remote === "string" ? params.remote : undefined,
        typeof params?.branch === "string" ? params.branch : undefined,
        Array.isArray(params?.options) ? params.options.map(String) : [],
      );
    case "gitPush":
      return gitPush(
        String(params?.repoRoot || ""),
        typeof params?.remote === "string" ? params.remote : undefined,
        typeof params?.branch === "string" ? params.branch : undefined,
        Array.isArray(params?.options) ? params.options.map(String) : [],
      );
    case "gitBranch":
      return gitBranch(String(params?.repoRoot || ""), Array.isArray(params?.options) ? params.options.map(String) : []);
    case "gitCheckoutBranch":
      return gitCheckoutBranch(
        String(params?.repoRoot || ""),
        String(params?.branch || ""),
        Array.isArray(params?.options) ? params.options.map(String) : [],
      );
    case "gitLogRemoteOnly":
      return gitLogRemoteOnly(
        String(params?.repoRoot || ""),
        String(params?.localBranch || ""),
        String(params?.remoteBranch || ""),
      );
    case "gitClone":
      return gitClone(
        String(params?.repoPath || ""),
        String(params?.gitUrl || ""),
        Boolean(params?.createMainBranch),
      );
    case "gitValidateUrl":
      return gitValidateUrl(String(params?.gitUrl || ""));
    case "getGitConfig":
      return getGitConfig();
    case "setGitConfig":
      return setGitConfig(String(params?.name || ""), String(params?.email || ""));
    case "checkGitHubCredentials":
      return checkGitHubCredentials();
    case "storeGitHubCredentials":
      return storeGitHubCredentials(String(params?.username || ""), String(params?.token || ""));
    case "removeGitHubCredentials":
      return removeGitHubCredentials();
    case "gitCreateBranch":
      return gitCreateBranch(
        String(params?.repoRoot || ""),
        String(params?.branchName || ""),
        Array.isArray(params?.options) ? params.options.map(String) : [],
      );
    case "gitDeleteBranch":
      return gitDeleteBranch(
        String(params?.repoRoot || ""),
        String(params?.branchName || ""),
        Array.isArray(params?.options) ? params.options.map(String) : [],
      );
    case "gitTrackRemoteBranch":
      return gitTrackRemoteBranch(
        String(params?.repoRoot || ""),
        String(params?.branchName || ""),
        typeof params?.remoteName === "string" ? params.remoteName : undefined,
      );
    case "initGit":
      return initGit(String(params?.repoRoot || ""));
    default:
      return undefined;
  }
}

self.onmessage = async (event) => {
  const message = event.data as RequestMessage | undefined;

  if (!message || message.type !== "request") {
    return;
  }

  try {
    const payload = await handleRequest(String(message.method || ""), message.params);
    postResponse(message.requestId, true, payload);
  } catch (error) {
    postResponse(
      message.requestId,
      false,
      undefined,
      error instanceof Error ? error.message : String(error),
    );
  }
};

self.postMessage({ type: "ready" });
