import { execFileSync } from "node:child_process";
import { assertStrictSemVer } from "../src/shared/strict-semver.js";

function defaultRunGit(args, options) {
	return execFileSync("git", args, options);
}

export function assertReleaseGitState(repositoryRoot, runGit = defaultRunGit) {
	const options = { cwd: repositoryRoot, encoding: "utf8" };
	const branch = String(runGit(["branch", "--show-current"], options)).trim();
	if (branch !== "main") {
		throw new Error(
			`Release helper must run on the main branch; current branch is ${branch || "detached HEAD"}.`,
		);
	}

	const status = String(
		runGit(
			["status", "--porcelain=v1", "--untracked-files=all"],
			options,
		),
	).trim();
	if (status !== "") {
		throw new Error(
			"Release helper requires a clean worktree; commit or stash all changes first.",
		);
	}
}

export function pushReleaseAtomically(
	repositoryRoot,
	tagName,
	runGit = defaultRunGit,
) {
	if (typeof tagName !== "string" || !tagName.startsWith("v")) {
		throw new Error(
			`Release tag must start with v, got ${JSON.stringify(tagName)}.`,
		);
	}
	assertStrictSemVer(tagName.slice(1), "release tag");
	runGit(
		[
			"push",
			"--atomic",
			"origin",
			"HEAD:refs/heads/main",
			`refs/tags/${tagName}:refs/tags/${tagName}`,
		],
		{ cwd: repositoryRoot, stdio: "inherit" },
	);
}
