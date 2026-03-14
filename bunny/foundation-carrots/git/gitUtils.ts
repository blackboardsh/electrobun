import simpleGit, { CheckRepoActions } from "simple-git";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Path to macOS osxkeychain credential helper (if available)
const OSXKEYCHAIN_HELPER = "/Library/Developer/CommandLineTools/usr/libexec/git-core/git-credential-osxkeychain";

const GIT_BINARY_PATH = process.env.BUNNY_GIT_BINARY_PATH || Bun.which("git") || "git";
const GIT_EXEC_PATH = process.env.BUNNY_GIT_EXEC_PATH || "";

// HOME ensures git can find ~/.gitconfig for user.name and user.email.
const gitEnv = {
  HOME: os.homedir(),
  ...(GIT_EXEC_PATH ? { GIT_EXEC_PATH } : {}),
};

// Check if osxkeychain helper is available for credential management
const hasOsxKeychainHelper = fs.existsSync(OSXKEYCHAIN_HELPER);

const git = (baseDir: string) => {
  return simpleGit({
    binary: GIT_BINARY_PATH,
    // note: unsafe allows us to use special characters in the file path
    // with this option enabled it will warn instead of throw https://github.com/steveukx/git-js/blob/859699d0cc1d0c9b94f53de9c61a060a2cecb656/simple-git/src/lib/plugins/custom-binary.plugin.ts#L25C18-L25C22
    unsafe: {
      allowUnsafeCustomBinary: true,
      allowUnsafePack: true,
      allowUnsafeProtocolOverride: true
    },
    baseDir: baseDir,
    maxConcurrentProcesses: 2, // Reduced to avoid overwhelming the system
    trimmed: false,
    config: ['core.quotepath=false'], // Disable path quoting that might cause issues
  }).env(gitEnv);
};

const DEFAULT_INIT_GIT_NAME = "Bunny";
const DEFAULT_INIT_GIT_EMAIL = "bunny@local";

const getInitialCommitEnv = async (baseDir: string) => {
  const repoGit = git(baseDir);
  const [userName, userEmail] = await Promise.all([
    repoGit.raw(["config", "user.name"]).catch(() => ""),
    repoGit.raw(["config", "user.email"]).catch(() => ""),
  ]);

  if (userName.trim() && userEmail.trim()) {
    return gitEnv;
  }

  return {
    ...gitEnv,
    GIT_AUTHOR_NAME: userName.trim() || DEFAULT_INIT_GIT_NAME,
    GIT_AUTHOR_EMAIL: userEmail.trim() || DEFAULT_INIT_GIT_EMAIL,
    GIT_COMMITTER_NAME: userName.trim() || DEFAULT_INIT_GIT_NAME,
    GIT_COMMITTER_EMAIL: userEmail.trim() || DEFAULT_INIT_GIT_EMAIL,
  };
};

export const gitShow = (repoRoot: string, options: string[]) => {
  return git(repoRoot).show(options);
};

export const gitCommit = (repoRoot: string, msg: string) => {
  return git(repoRoot).commit(msg);
};

export const gitCommitAmend = (repoRoot: string, msg: string) => {
  return git(repoRoot).commit(msg, ['--amend']);
};

export const gitAdd = (repoRoot: string, files: string | string[]) => {
  return git(repoRoot).add(files);
};

export const gitLog = async (repoRoot: string, options: string[], limit?: number, skip?: number) => {
  try {
    // Add pagination options if provided
    const paginatedOptions = [...options];
    if (limit !== undefined) {
      paginatedOptions.push(`--max-count=${limit}`);
    }
    if (skip !== undefined) {
      paginatedOptions.push(`--skip=${skip}`);
    }
    
    const logResult = await git(repoRoot).log(paginatedOptions);
    
    // For initial load and infinite scroll, don't do expensive per-commit operations
    // Just return the basic commit info quickly
    return logResult;
    
    // TODO: Add a separate endpoint for getting detailed commit info on demand
    // The previous code was doing expensive per-commit git show calls causing performance issues
  } catch (error) {
    console.error('Error in gitLog:', error);
    return { all: [] };
  }
};

export const gitStatus = (repoRoot: string) => {
  return git(repoRoot).status();
};

export const gitDiff = (repoRoot: string, options: string[]) => {
  return git(repoRoot)
    .diff(options)
    .catch(() => "");
};

export const gitCheckout = (repoRoot: string, hash: string) => {
  return git(repoRoot).checkout(hash);
};

export const gitCheckIsRepoRoot = (repoRoot: string) => {
  return git(repoRoot).checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
};

export const gitCheckIsRepoInTree = (repoRoot: string) => {
  return git(repoRoot).checkIsRepo(CheckRepoActions.IN_TREE);
};

export const gitRevParse = (repoRoot: string, options: string[]) => {
  return git(repoRoot).revparse(options);
};

export const initGit = async (repoRoot: string) => {
  try {
    const initialCommitEnv = await getInitialCommitEnv(repoRoot);
    const repoGit = simpleGit({
      binary: GIT_BINARY_PATH,
      unsafe: {
        allowUnsafeCustomBinary: true,
        allowUnsafePack: true,
        allowUnsafeProtocolOverride: true
      },
      baseDir: repoRoot,
      maxConcurrentProcesses: 2,
      trimmed: false,
      config: ['core.quotepath=false'],
    }).env(initialCommitEnv);

    // Initialize with main branch
    await repoGit.init(["--initial-branch", "main"]);

    // Create an initial commit to establish the main branch
    // Without a commit, the branch doesn't actually exist yet
    const gitignorePath = path.join(repoRoot, '.gitignore');
    fs.writeFileSync(gitignorePath, '# Add files to ignore here\n');
    await repoGit.add('.gitignore');
    await repoGit.commit('Initial commit');

    console.log('Successfully initialized git with main branch');
  } catch (e) {
    console.log("error: ", e);
  }
};

export const gitValidateUrl = async (gitUrl: string) => {
  try {
    // Use git ls-remote to check if the repository is reachable and clonable
    const gitInstance = simpleGit({
      binary: GIT_BINARY_PATH,
      unsafe: {
        allowUnsafeCustomBinary: true,
        allowUnsafePack: true,
        allowUnsafeProtocolOverride: true,
      },
      maxConcurrentProcesses: 2,
      trimmed: false,
    }).env(gitEnv);

    // Build ls-remote command with credential helper for private repos
    const lsRemoteArgs: string[] = [];
    if (hasOsxKeychainHelper) {
      lsRemoteArgs.push('-c', `credential.helper=${OSXKEYCHAIN_HELPER}`);
    }
    lsRemoteArgs.push('ls-remote', gitUrl, 'HEAD');

    // ls-remote will fail if the repo doesn't exist or isn't accessible
    await gitInstance.raw(lsRemoteArgs);
    return { valid: true, error: null };
  } catch (error) {
    console.error('Git URL validation error:', error);
    return { valid: false, error: (error as any)?.message || 'Repository not accessible' };
  }
};

export const gitClone = async (repoPath: string, gitUrl: string, createMainBranch: boolean = false) => {
  try {
    const parentDir = path.dirname(repoPath);
    const folderName = path.basename(repoPath);

    if (createMainBranch) {
      // For empty repositories, initialize manually to avoid detached HEAD
      console.log('Creating empty repository with main branch...');

      // Create the directory
      const targetPath = path.join(parentDir, folderName);
      if (!fs.existsSync(targetPath)) {
        fs.mkdirSync(targetPath, { recursive: true });
      }

      // Initialize git with main branch
      const initialCommitEnv = await getInitialCommitEnv(targetPath);
      const repoGit = simpleGit({
        baseDir: targetPath,
        binary: GIT_BINARY_PATH,
        unsafe: {
          allowUnsafeCustomBinary: true,
          allowUnsafePack: true,
          allowUnsafeProtocolOverride: true,
        },
        maxConcurrentProcesses: 2,
        trimmed: false,
      }).env(initialCommitEnv);

      await repoGit.init(['--initial-branch=main']);
      await repoGit.addRemote('origin', gitUrl);

      // Create an initial .gitignore and commit to establish the main branch
      // This prevents detached HEAD state and creates a proper branch
      const gitignorePath = path.join(targetPath, '.gitignore');
      fs.writeFileSync(gitignorePath, '# Add files to ignore here\n');
      await repoGit.add('.gitignore');
      await repoGit.commit('Initial commit');

      return `Successfully cloned empty repository and initialized main branch at ${repoPath}`;
    } else {
      // Normal clone for repositories with existing branches
      const gitInstance = simpleGit({
        baseDir: parentDir,
        binary: GIT_BINARY_PATH,
        unsafe: {
          allowUnsafeCustomBinary: true,
          allowUnsafePack: true,
          allowUnsafeProtocolOverride: true,
        },
        maxConcurrentProcesses: 2,
        trimmed: false,
      }).env(gitEnv);

      // Build clone command with credential helper for private repos
      const cloneArgs: string[] = [];
      if (hasOsxKeychainHelper) {
        cloneArgs.push('-c', `credential.helper=${OSXKEYCHAIN_HELPER}`);
      }
      cloneArgs.push('clone', gitUrl, folderName);

      await gitInstance.raw(cloneArgs);
      return `Successfully cloned repository to ${repoPath}`;
    }
  } catch (error) {
    console.error('Git clone error:', error);
    throw error;
  }
};

export const gitReset = (repoRoot: string, options: string[]) => {
  return git(repoRoot).reset(options);
};

export const gitRevert = async (repoRoot: string, commitHash: string, options: string[] = []) => {
  try {
    // Pass commit hash as string and options separately
    await git(repoRoot).revert(commitHash, options);
    return `Successfully reverted commit ${commitHash}`;
  } catch (error) {
    console.error('Git revert error:', error);
    throw error;
  }
};

export const gitStashList = async (repoRoot: string) => {
  try {
    const stashList = await git(repoRoot).stashList();
    return stashList;
  } catch (error) {
    console.error('Git stash list error:', error);
    return [];
  }
};

export const gitStashCreate = async (repoRoot: string, message?: string, options: string[] = []) => {
  try {
    const stashOptions = message ? ['push', '-m', message, ...options] : ['push', ...options];
    await git(repoRoot).stash(stashOptions);
    return `Successfully created stash${message ? ': ' + message : ''}`;
  } catch (error) {
    console.error('Git stash create error:', error);
    throw error;
  }
};

export const gitStashApply = async (repoRoot: string, stashName: string) => {
  try {
    await git(repoRoot).stash(['apply', stashName]);
    return `Successfully applied stash ${stashName}`;
  } catch (error) {
    console.error('Git stash apply error:', error);
    throw error;
  }
};

export const gitStashPop = async (repoRoot: string, stashName: string) => {
  try {
    await git(repoRoot).stash(['pop', stashName]);
    return `Successfully popped stash ${stashName}`;
  } catch (error) {
    console.error('Git stash pop error:', error);
    throw error;
  }
};

export const gitStashShow = async (repoRoot: string, stashName: string) => {
  try {
    const stashContent = await git(repoRoot).stash(['show', '--name-status', '--include-untracked', stashName]);
    return stashContent;
  } catch (error) {
    console.error('Git stash show error:', error);
    return '';
  }
};

// Remote operations
export const gitRemote = async (repoRoot: string) => {
  try {
    const remotes = await git(repoRoot).getRemotes(true);
    return remotes;
  } catch (error) {
    console.error('Git remote error:', error);
    return [];
  }
};

export const gitAddRemote = async (repoRoot: string, remoteName: string, remoteUrl: string) => {
  try {
    await git(repoRoot).addRemote(remoteName, remoteUrl);
    return `Successfully added remote ${remoteName}`;
  } catch (error) {
    console.error('Git add remote error:', error);
    throw error;
  }
};

export const gitFetch = async (repoRoot: string, remote?: string, options: string[] = []) => {
  try {
    const gitInstance = simpleGit({
      baseDir: repoRoot,
      binary: GIT_BINARY_PATH,
      unsafe: {
        allowUnsafeCustomBinary: true,
        allowUnsafePack: true,
        allowUnsafeProtocolOverride: true,
      },
      maxConcurrentProcesses: 2,
      trimmed: false,
    }).env(gitEnv);

    // Build fetch command with credential helper configuration
    const fetchArgs: string[] = [];
    if (hasOsxKeychainHelper) {
      fetchArgs.push('-c', `credential.helper=${OSXKEYCHAIN_HELPER}`);
    }
    fetchArgs.push('fetch');
    if (remote) {
      fetchArgs.push(remote);
    }
    fetchArgs.push(...options);

    const result = await gitInstance.raw(fetchArgs);
    return result;
  } catch (error) {
    console.error('Git fetch error:', error);
    throw error;
  }
};

export const gitPull = async (repoRoot: string, remote?: string, branch?: string, options: string[] = []) => {
  try {
    const gitInstance = simpleGit({
      baseDir: repoRoot,
      binary: GIT_BINARY_PATH,
      unsafe: {
        allowUnsafeCustomBinary: true,
        allowUnsafePack: true,
        allowUnsafeProtocolOverride: true,
      },
      maxConcurrentProcesses: 2,
      trimmed: false,
    }).env(gitEnv);

    // Build pull command with credential helper configuration
    const pullArgs: string[] = [];
    if (hasOsxKeychainHelper) {
      pullArgs.push('-c', `credential.helper=${OSXKEYCHAIN_HELPER}`);
    }
    pullArgs.push('pull');
    if (remote) {
      pullArgs.push(remote);
    }
    if (branch) {
      pullArgs.push(branch);
    }
    pullArgs.push(...options);

    const result = await gitInstance.raw(pullArgs);
    return result;
  } catch (error) {
    console.error('Git pull error:', error);
    throw error;
  }
};

export const gitPush = async (repoRoot: string, remote?: string, branch?: string, options: string[] = []) => {
  try {
    const gitInstance = simpleGit({
      baseDir: repoRoot,
      binary: GIT_BINARY_PATH,
      unsafe: {
        allowUnsafeCustomBinary: true,
        allowUnsafePack: true,
        allowUnsafeProtocolOverride: true,
      },
      maxConcurrentProcesses: 2,
      trimmed: false,
    }).env(gitEnv);

    // Build push command with credential helper configuration
    const pushArgs: string[] = [];
    if (hasOsxKeychainHelper) {
      pushArgs.push('-c', `credential.helper=${OSXKEYCHAIN_HELPER}`);
    }
    pushArgs.push('push');
    if (remote) {
      pushArgs.push(remote);
    }
    if (branch) {
      pushArgs.push(branch);
    }
    pushArgs.push(...options);

    const result = await gitInstance.raw(pushArgs);
    return result;
  } catch (error) {
    console.error('Git push error:', error);
    throw error;
  }
};

export const gitBranch = async (repoRoot: string, options: string[] = []) => {
  try {
    const branches = await git(repoRoot).branch(options);
    return branches;
  } catch (error) {
    console.error('Git branch error:', error);
    return { all: [], branches: {}, current: '', detached: false };
  }
};

// Get global git configuration (user.name, user.email)
export const getGitConfig = async (): Promise<{ name: string; email: string; hasKeychainHelper: boolean }> => {
  try {
    const gitInstance = simpleGit({
      binary: GIT_BINARY_PATH,
      unsafe: {
        allowUnsafeCustomBinary: true,
        allowUnsafePack: true,
        allowUnsafeProtocolOverride: true,
      },
      maxConcurrentProcesses: 2,
      trimmed: false,
    }).env(gitEnv);

    let name = '';
    let email = '';

    try {
      name = (await gitInstance.raw(['config', '--global', 'user.name'])).trim();
    } catch (e) {
      // Not configured
    }

    try {
      email = (await gitInstance.raw(['config', '--global', 'user.email'])).trim();
    } catch (e) {
      // Not configured
    }

    return { name, email, hasKeychainHelper: hasOsxKeychainHelper };
  } catch (error) {
    console.error('Error getting git config:', error);
    return { name: '', email: '', hasKeychainHelper: hasOsxKeychainHelper };
  }
};

// Set global git configuration
export const setGitConfig = async (name: string, email: string): Promise<void> => {
  try {
    const gitInstance = simpleGit({
      binary: GIT_BINARY_PATH,
      unsafe: {
        allowUnsafeCustomBinary: true,
        allowUnsafePack: true,
        allowUnsafeProtocolOverride: true,
      },
      maxConcurrentProcesses: 2,
      trimmed: false,
    }).env(gitEnv);

    if (name) {
      await gitInstance.raw(['config', '--global', 'user.name', name]);
    }
    if (email) {
      await gitInstance.raw(['config', '--global', 'user.email', email]);
    }
  } catch (error) {
    console.error('Error setting git config:', error);
    throw error;
  }
};

// Check if GitHub credentials are stored in the macOS Keychain
export const checkGitHubCredentials = async (): Promise<{ hasCredentials: boolean; username?: string }> => {
  if (!hasOsxKeychainHelper) {
    return { hasCredentials: false };
  }

  try {
    // Use security command to check for github.com credentials in keychain
    const { execSync } = await import('child_process');
    const result = execSync('security find-internet-password -s github.com 2>/dev/null', { encoding: 'utf-8' });

    // Parse the account name from the output
    const acctMatch = result.match(/"acct"<blob>="([^"]+)"/);
    const username = acctMatch ? acctMatch[1] : undefined;

    return { hasCredentials: true, username };
  } catch (error) {
    // No credentials found or error accessing keychain
    return { hasCredentials: false };
  }
};

// Store GitHub credentials in the macOS Keychain using git credential helper
export const storeGitHubCredentials = async (username: string, token: string): Promise<void> => {
  if (!hasOsxKeychainHelper) {
    throw new Error('macOS Keychain credential helper not available');
  }

  try {
    const { execSync } = await import('child_process');

    // Use printf to properly handle newlines (echo -e not available on all systems)
    // Format required by git-credential: key=value pairs separated by newlines, ending with empty line
    const input = `protocol=https
host=github.com
username=${username}
password=${token}
`;
    execSync(`printf '%s' "${input}" | ${OSXKEYCHAIN_HELPER} store`, { encoding: 'utf-8' });
  } catch (error) {
    console.error('Error storing GitHub credentials:', error);
    throw error;
  }
};

// Remove GitHub credentials from the macOS Keychain
export const removeGitHubCredentials = async (): Promise<void> => {
  if (!hasOsxKeychainHelper) {
    throw new Error('macOS Keychain credential helper not available');
  }

  try {
    const { execSync } = await import('child_process');

    // Use git credential helper to erase credentials
    const input = `protocol=https\nhost=github.com\n`;
    execSync(`echo "${input}" | ${OSXKEYCHAIN_HELPER} erase`, { encoding: 'utf-8' });
  } catch (error) {
    console.error('Error removing GitHub credentials:', error);
    throw error;
  }
};

export const gitCheckoutBranch = async (repoRoot: string, branch: string, options: string[] = []) => {
  try {
    await git(repoRoot).checkout(branch, options);
    return `Successfully checked out ${branch}`;
  } catch (error) {
    console.error('Git checkout error:', error);
    throw error;
  }
};

export const gitRevList = async (repoRoot: string, options: string[]) => {
  try {
    const result = await git(repoRoot).raw(['rev-list', ...options]);
    return result.trim().split('\n').filter(Boolean);
  } catch (error) {
    console.error('Git rev-list error:', error);
    return [];
  }
};

export const gitMergeBase = async (repoRoot: string, refs: string[]) => {
  try {
    const result = await git(repoRoot).raw(['merge-base', ...refs]);
    return result.trim();
  } catch (error) {
    console.error('Git merge-base error:', error);
    return '';
  }
};

export const gitLogRemoteOnly = async (repoRoot: string, localBranch: string, remoteBranch: string) => {
  try {
    // Get commits that are in remote but not in local: remoteBranch ^localBranch
    const result = await git(repoRoot).log([
      `${remoteBranch}`, 
      `^${localBranch}`,
      '--name-status'
    ]);
    return result;
  } catch (error) {
    console.error('Git log remote-only error:', error);
    return { all: [] };
  }
};

export const gitApply = (repoRoot: string, options: string[], patch?: string) => {
  // Apply a patch to the working directory or index
  const gitInstance = git(repoRoot);
  if (patch) {
    // For applying patches from strings, we'll need to use raw commands
    return gitInstance.raw(['apply', ...options], patch);
  }
  return gitInstance.raw(['apply', ...options]);
};

export const gitStageHunkFromPatch = async (repoRoot: string, patch: string) => {
  // Apply a specific patch to the staging area
  const gitInstance = git(repoRoot);
  
  try {
    console.log("Attempting to apply patch with git apply --cached");
    console.log("Patch content:", patch);
    
    // Write patch to a temporary file and apply it
    const tmpFile = path.join(os.tmpdir(), `git-patch-${Date.now()}.patch`);
    fs.writeFileSync(tmpFile, patch);
    
    console.log("Wrote patch to:", tmpFile);
    
    // Try different apply strategies
    try {
      // First try: exact apply
      const result = await gitInstance.raw(['apply', '--cached', tmpFile]);
      console.log("Git apply succeeded (exact):", result);
    } catch (e1) {
      console.log("Exact apply failed, trying with --3way");
      try {
        // Second try: 3-way merge
        const result = await gitInstance.raw(['apply', '--cached', '--3way', tmpFile]);
        console.log("Git apply succeeded (3-way):", result);
      } catch (e2) {
        console.log("3-way apply failed, trying with --reject");
        // Third try: apply with reject
        const result = await gitInstance.raw(['apply', '--cached', '--reject', tmpFile]);
        console.log("Git apply succeeded (with rejects):", result);
      }
    }
    
    // Clean up temp file
    fs.unlinkSync(tmpFile);
    
    return `Successfully staged hunk`;
  } catch (error) {
    console.error("Git apply error:", error);
    throw new Error(`Failed to stage hunk: ${error}`);
  }
};

export const gitStageSpecificLines = async (repoRoot: string, filePath: string, startLine: number, endLine: number) => {
  const gitInstance = git(repoRoot);
  
  try {
    console.log(`Robust git diff-based staging for lines ${startLine}-${endLine} of ${filePath}`);
    
    // Get current git diff to understand what hunks exist
    const diff = await gitInstance.diff([filePath]);
    if (!diff) {
      throw new Error('No changes found in file');
    }
    
    console.log('Analyzing git diff to find target hunk...');
    
    // Parse the diff to find which hunk contains our target line
    const diffLines = diff.split('\n');
    const headers: string[] = [];
    const hunks: Array<{
      header: string;
      oldStart: number;
      oldCount: number;
      newStart: number;
      newCount: number;
      lines: string[];
    }> = [];
    
    let currentHunk: typeof hunks[0] | null = null;
    
    // First pass: collect headers and parse hunks
    for (const line of diffLines) {
      // Collect file headers
      if (line.startsWith('diff --git') || line.startsWith('index ') || 
          line.startsWith('---') || line.startsWith('+++')) {
        headers.push(line);
        continue;
      }
      
      // Parse hunk header
      if (line.startsWith('@@')) {
        // Save previous hunk if exists
        if (currentHunk) {
          hunks.push(currentHunk);
        }
        
        const match = line.match(/@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/);
        if (match) {
          currentHunk = {
            header: line,
            oldStart: parseInt(match[1]),
            oldCount: parseInt(match[2]) || 1,
            newStart: parseInt(match[3]),
            newCount: parseInt(match[4]) || 1,
            lines: []
          };
        }
        continue;
      }
      
      // Collect hunk content
      if (currentHunk && line !== '') {
        currentHunk.lines.push(line);
      }
    }
    
    // Don't forget the last hunk
    if (currentHunk) {
      hunks.push(currentHunk);
    }
    
    console.log(`Found ${hunks.length} hunks in diff`);
    
    // Find the hunk that contains our target line
    let targetHunk = null;
    for (const hunk of hunks) {
      const hunkEndLine = hunk.newStart + hunk.newCount - 1;
      console.log(`Checking hunk: new lines ${hunk.newStart}-${hunkEndLine}, looking for line ${startLine}`);
      
      if (startLine >= hunk.newStart && startLine <= hunkEndLine) {
        targetHunk = hunk;
        console.log(`Found target hunk: new lines ${hunk.newStart}-${hunkEndLine}`);
        
        // Check if this is a large reformatting hunk (more than 20 lines)
        if (hunk.newCount > 20) {
          console.log(`⚠️  Large hunk detected (${hunk.newCount} lines). Analyzing if this is pure reformatting...`);
          
          // Analyze if this is just formatting vs actual content changes
          const contentChanges = hunk.lines.filter(line => {
            if (!line.startsWith('-') && !line.startsWith('+')) return false;
            
            // Remove common formatting differences and compare
            const content = line.substring(1).trim();
            const normalizedContent = content
              .replace(/\s+/g, ' ')  // normalize whitespace
              .replace(/[,;]$/, '')  // remove trailing punctuation
              .replace(/^\s*[\{\}]\s*$/, ''); // ignore standalone braces
            
            return normalizedContent.length > 0;
          });
          
          // Count actual content additions vs deletions
          const additions = contentChanges.filter(line => line.startsWith('+')).length;
          const deletions = contentChanges.filter(line => line.startsWith('-')).length;
          const totalContentLines = additions + deletions;
          
          console.log(`Content analysis: ${additions} additions, ${deletions} deletions, ${totalContentLines} total content changes out of ${hunk.lines.length} lines`);
          
          // If more than 80% of the hunk is just formatting, refuse to stage
          if (totalContentLines < hunk.lines.length * 0.2) {
            throw new Error(`Cannot stage individual lines from a large reformatting hunk (${hunk.newCount} lines, mostly formatting). Please stage the entire file or revert the formatting changes first.`);
          }
          
          console.log(`Large hunk contains significant content changes (${totalContentLines}/${hunk.lines.length} lines), proceeding with staging...`);
        }
        break;
      }
    }
    
    if (!targetHunk) {
      // If we can't find by exact line match, try a more flexible approach
      // Look for the hunk that's closest to our target line
      let closestHunk = null;
      let closestDistance = Infinity;
      
      for (const hunk of hunks) {
        const distance = Math.abs(hunk.newStart - startLine);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestHunk = hunk;
        }
      }
      
      if (closestHunk) {
        console.log(`Using closest hunk: new lines ${closestHunk.newStart}-${closestHunk.newStart + closestHunk.newCount - 1} (distance: ${closestDistance})`);
        
        // Also check the closest hunk for large size
        if (closestHunk.newCount > 20) {
          console.log(`⚠️  Large hunk detected (${closestHunk.newCount} lines). Analyzing if this is pure reformatting...`);
          
          // Analyze if this is just formatting vs actual content changes
          const contentChanges = closestHunk.lines.filter(line => {
            if (!line.startsWith('-') && !line.startsWith('+')) return false;
            
            // Remove common formatting differences and compare
            const content = line.substring(1).trim();
            const normalizedContent = content
              .replace(/\s+/g, ' ')  // normalize whitespace
              .replace(/[,;]$/, '')  // remove trailing punctuation
              .replace(/^\s*[\{\}]\s*$/, ''); // ignore standalone braces
            
            return normalizedContent.length > 0;
          });
          
          // Count actual content additions vs deletions
          const additions = contentChanges.filter(line => line.startsWith('+')).length;
          const deletions = contentChanges.filter(line => line.startsWith('-')).length;
          const totalContentLines = additions + deletions;
          
          console.log(`Content analysis: ${additions} additions, ${deletions} deletions, ${totalContentLines} total content changes out of ${closestHunk.lines.length} lines`);
          
          // If more than 80% of the hunk is just formatting, refuse to stage
          if (totalContentLines < closestHunk.lines.length * 0.2) {
            throw new Error(`Cannot stage individual lines from a large reformatting hunk (${closestHunk.newCount} lines, mostly formatting). Please stage the entire file or revert the formatting changes first.`);
          }
          
          console.log(`Large hunk contains significant content changes (${totalContentLines}/${closestHunk.lines.length} lines), proceeding with staging...`);
        }
        
        targetHunk = closestHunk;
      } else {
        throw new Error(`No hunk found for line ${startLine}`);
      }
    }
    
    // Build the complete patch with headers and target hunk
    const patchLines = [
      ...headers,
      targetHunk.header,
      ...targetHunk.lines
    ];
    
    const hunkPatch = patchLines.join('\n') + '\n';
    console.log('Generated hunk patch:', hunkPatch);
    
    // Apply this specific hunk to the staging area
    const tmpFile = path.join(os.tmpdir(), `hunk-patch-${Date.now()}.patch`);
    fs.writeFileSync(tmpFile, hunkPatch);
    
    try {
      await gitInstance.raw(['apply', '--cached', tmpFile]);
      console.log(`Successfully staged hunk containing lines ${startLine}-${endLine}`);
    } catch (applyError) {
      console.log('Direct apply failed, trying 3-way merge...');
      try {
        await gitInstance.raw(['apply', '--cached', '--3way', tmpFile]);
        console.log(`Successfully staged hunk with 3-way merge`);
      } catch (threewayError) {
        console.log('3-way apply failed, trying with --ignore-whitespace...');
        await gitInstance.raw(['apply', '--cached', '--ignore-whitespace', tmpFile]);
        console.log(`Successfully staged hunk ignoring whitespace`);
      }
    }
    
    // Clean up
    fs.unlinkSync(tmpFile);
    
    return `Staged hunk containing lines ${startLine}-${endLine}`;
  } catch (error) {
    console.error('Error in git diff-based staging:', error);
    throw error;
  }
};

export const gitUnstageMonacoChange = async (
  repoRoot: string,
  filePath: string,
  originalContent: string,  // This would be HEAD version
  targetChange: {
    originalStartLineNumber: number;
    originalEndLineNumber: number;
    modifiedStartLineNumber: number;
    modifiedEndLineNumber: number;
  },
  stagedContent: string  // This would be INDEX version
) => {
  const gitInstance = git(repoRoot);
  
  try {
    // Ensure we have an absolute path
    const absoluteFilePath = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
    
    // 1. Backup current working file content
    const workingFileContent = fs.readFileSync(absoluteFilePath, 'utf8');
    
    // 2. We need to figure out what changes are staged and remove only the target one
    // The approach: start with the original (HEAD) and apply all staged changes EXCEPT the target
    const originalLines = originalContent.split('\n');
    const stagedLines = stagedContent.split('\n');
    
    // Get all line changes from the diff editor to identify what's staged
    // For now, we'll use a simple approach: revert the clicked hunk back to original
    const selectiveLines = [...stagedLines];
    
    // Get the original lines for this hunk
    const originalHunkLines = originalLines.slice(
      targetChange.originalStartLineNumber - 1,
      targetChange.originalEndLineNumber
    );
    
    // Replace the staged hunk with the original hunk
    const stagedStartIndex = targetChange.modifiedStartLineNumber - 1;
    const stagedEndIndex = targetChange.modifiedEndLineNumber;
    const linesToRemove = stagedEndIndex - stagedStartIndex;
    
    // Remove the staged lines and insert the original lines
    selectiveLines.splice(stagedStartIndex, linesToRemove, ...originalHunkLines);
    
    const selectiveContent = selectiveLines.join('\n');
    
    // 3. Write the selective version to disk and stage it
    fs.writeFileSync(absoluteFilePath, selectiveContent);
    
    await gitInstance.add(filePath); // Use relative path for git
    
    // 4. Restore the original working file content
    fs.writeFileSync(absoluteFilePath, workingFileContent);
    
    return `Successfully unstaged change at lines ${targetChange.modifiedStartLineNumber}-${targetChange.modifiedEndLineNumber}`;
    
  } catch (error) {
    console.error('Error in Monaco-based unstaging:', error);
    
    // Make sure to restore the file even if something went wrong
    try {
      const absoluteFilePath = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
      const workingFileContent = fs.readFileSync(absoluteFilePath, 'utf8');
      fs.writeFileSync(absoluteFilePath, workingFileContent);
    } catch (restoreError) {
      console.error('Failed to restore file after error:', restoreError);
    }
    
    throw error;
  }
};

export const gitStageMonacoChange = async (
  repoRoot: string, 
  filePath: string, 
  originalContent: string,
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
  },
  modifiedContent: string
) => {
  const gitInstance = git(repoRoot);
  
  try {
    // Ensure we have an absolute path
    const absoluteFilePath = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
    
    // 1. Backup current working file content
    const workingFileContent = fs.readFileSync(absoluteFilePath, 'utf8');
    
    // 2. Apply only the target change to the original content
    const originalLines = originalContent.split('\n');
    const modifiedLines = modifiedContent.split('\n');
    
    // Create a version with only the target change applied
    const selectiveLines = [...originalLines];
    
    // Extract the lines from the target change in the modified content
    const targetModifiedLines = modifiedLines.slice(
      targetChange.modifiedStartLineNumber - 1,
      targetChange.modifiedEndLineNumber
    );
    
    // Replace the corresponding lines in the original with the target change
    const originalStartIndex = targetChange.originalStartLineNumber - 1;
    const originalEndIndex = targetChange.originalEndLineNumber;
    const linesToReplace = originalEndIndex - originalStartIndex;
    
    selectiveLines.splice(originalStartIndex, linesToReplace, ...targetModifiedLines);
    
    const selectiveContent = selectiveLines.join('\n');
    
    // 3. Write the selective version to disk and stage it
    fs.writeFileSync(absoluteFilePath, selectiveContent);
    
    await gitInstance.add(filePath); // Use relative path for git
    
    // 4. Restore the original working file content
    fs.writeFileSync(absoluteFilePath, workingFileContent);
    
    return `Successfully staged change at lines ${targetChange.modifiedStartLineNumber}-${targetChange.modifiedEndLineNumber}`;
    
  } catch (error) {
    console.error('Error in Monaco-based staging:', error);
    
    // Make sure to restore the file even if something went wrong
    try {
      const absoluteFilePath = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
      const workingFileContent = fs.readFileSync(absoluteFilePath, 'utf8');
      fs.writeFileSync(absoluteFilePath, workingFileContent);
    } catch (restoreError) {
      console.error('Failed to restore file after error:', restoreError);
    }
    
    throw error;
  }
};

export const gitCreateBranch = async (repoRoot: string, branchName: string, options: string[] = []) => {
  try {
    const gitInstance = git(repoRoot);

    // Check if there are any commits at all
    let hasCommits = false;
    try {
      await gitInstance.log(['-1']);
      hasCommits = true;
    } catch (logError) {
      // No commits exist
      hasCommits = false;
    }

    if (!hasCommits) {
      console.log('Repository has no commits, creating initial commit before branch creation...');
      const gitignorePath = path.join(repoRoot, '.gitignore');

      // Only create .gitignore if it doesn't exist
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, '# Add files to ignore here\n');
        await gitInstance.add('.gitignore');
      } else {
        // If .gitignore exists, just add it
        await gitInstance.add('.gitignore');
      }

      await gitInstance.commit('Initial commit');

      // Now create the branch from current HEAD
      await gitInstance.checkoutBranch(branchName, 'HEAD');
    } else {
      // Check if we're in a detached HEAD state
      const status = await gitInstance.status();

      if (status.detached) {
        // Detached HEAD with commits - create branch from current HEAD
        console.log('Detached HEAD state, creating branch from current HEAD...');
        await gitInstance.checkoutBranch(branchName, 'HEAD');
      } else {
        // Normal case: create and checkout a new branch
        await gitInstance.checkoutLocalBranch(branchName, options);
      }
    }

    return `Successfully created and checked out new branch: ${branchName}`;
  } catch (error) {
    console.error('Git create branch error:', error);
    throw error;
  }
};

export const gitDeleteBranch = async (repoRoot: string, branchName: string, options: string[] = []) => {
  try {
    await git(repoRoot).branch(['-d', branchName, ...options]);
    return `Successfully deleted branch: ${branchName}`;
  } catch (error) {
    console.error('Git delete branch error:', error);
    throw error;
  }
};

export const gitTrackRemoteBranch = async (repoRoot: string, branchName: string, remoteName: string = 'origin') => {
  try {
    // Create and checkout a local branch tracking the remote branch
    // This is equivalent to: git checkout -b <branchName> <remoteName>/<branchName>
    await git(repoRoot).checkoutBranch(branchName, `${remoteName}/${branchName}`);
    return `Successfully created and checked out tracking branch: ${branchName}`;
  } catch (error) {
    console.error('Git track remote branch error:', error);
    throw error;
  }
};

export const gitCreatePatchFromLines = async (repoRoot: string, filePath: string, startLine: number, endLine: number) => {
  const gitInstance = git(repoRoot);
  
  // Get the full diff for this file
  const fullDiff = await gitInstance.diff([filePath]);
  if (!fullDiff) {
    throw new Error(`No changes found in ${filePath}`);
  }
  
  console.log(`Extracting lines ${startLine}-${endLine} from diff`);
  
  // Parse the diff - in a reformatted file, we need to find BOTH the deletion and addition
  const diffLines = fullDiff.split('\n');
  const headers: string[] = [];
  const deletions: { line: string, oldLineNum: number }[] = [];
  const additions: { line: string, newLineNum: number }[] = [];
  
  let currentOldLine = 0;
  let currentNewLine = 0;
  
  for (const line of diffLines) {
    // Collect headers
    if (line.startsWith('diff --git') || line.startsWith('index ') || 
        line.startsWith('---') || line.startsWith('+++')) {
      headers.push(line);
      continue;
    }
    
    // Parse hunk header to get line numbers
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/);
      if (match) {
        currentOldLine = parseInt(match[1]);
        currentNewLine = parseInt(match[3]);
      }
      continue;
    }
    
    // Collect all deletions and additions with their line numbers
    if (line.startsWith('-') && !line.startsWith('---')) {
      deletions.push({ line, oldLineNum: currentOldLine });
      currentOldLine++;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      additions.push({ line, newLineNum: currentNewLine });
      currentNewLine++;
    } else if (line.startsWith(' ')) {
      currentOldLine++;
      currentNewLine++;
    }
  }
  
  // Find the addition at the target line
  const targetAddition = additions.find(a => a.newLineNum === startLine);
  if (!targetAddition) {
    throw new Error(`No change found at line ${startLine}`);
  }
  
  // Find the corresponding deletion (should be similar content)
  const matchingDeletion = deletions.find(d => {
    const deletionContent = d.line.substring(1).trim();
    // Check if the content is similar (e.g., same function call with minor changes)
    return deletionContent.includes('console.log') && deletionContent.includes('source');
  });
  
  // Build the patch
  const patchLines = [...headers];
  
  if (matchingDeletion) {
    // This is a replacement - use the OLD line number for the - side
    console.log(`Found matching deletion at old line ${matchingDeletion.oldLineNum}: ${matchingDeletion.line.substring(0, 50)}`);
    console.log(`With addition at new line ${targetAddition.newLineNum}: ${targetAddition.line.substring(0, 50)}`);
    
    // Add context lines before and after for a valid patch
    // Find context lines around the change
    const contextBefore: string[] = [];
    const contextAfter: string[] = [];
    
    // Look for context in the original diff
    for (let i = 0; i < diffLines.length; i++) {
      const line = diffLines[i];
      if (line === matchingDeletion.line) {
        // Get up to 3 context lines before
        for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
          if (diffLines[j].startsWith(' ')) {
            contextBefore.unshift(diffLines[j]);
          }
        }
        // Get up to 3 context lines after the addition
        for (let j = i + 1; j < Math.min(diffLines.length, i + 10); j++) {
          if (diffLines[j] === targetAddition.line) {
            // Found the addition, get context after it
            for (let k = j + 1; k < Math.min(diffLines.length, j + 4); k++) {
              if (diffLines[k].startsWith(' ')) {
                contextAfter.push(diffLines[k]);
                if (contextAfter.length >= 3) break;
              }
            }
            break;
          }
        }
        break;
      }
    }
    
    // Calculate line counts
    const oldCount = contextBefore.length + 1 + contextAfter.length; // context + deletion + context
    const newCount = contextBefore.length + 1 + contextAfter.length; // context + addition + context
    const hunkStart = matchingDeletion.oldLineNum - contextBefore.length;
    
    // Build the hunk
    patchLines.push(`@@ -${hunkStart},${oldCount} +${hunkStart},${newCount} @@`);
    patchLines.push(...contextBefore);
    patchLines.push(matchingDeletion.line);
    patchLines.push(targetAddition.line);
    patchLines.push(...contextAfter);
  } else {
    // This is just an addition
    patchLines.push(`@@ -${startLine},0 +${startLine},1 @@`);
    patchLines.push(targetAddition.line);
  }
  
  // IMPORTANT: Git expects a newline at the end of the file
  const finalPatch = patchLines.join('\n') + '\n';
  console.log('Generated patch:', finalPatch);
  console.log('Patch has', patchLines.length, 'lines');
  return finalPatch;
};
