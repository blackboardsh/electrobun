---
name: review-pr
description: Review a GitHub pull request from its link, read the PR description, inspect the code locally only when useful, and judge whether the change is safe to run from a security and runtime-safety perspective. Use only after the user pastes a PR URL. Handle one PR at a time, make a clear merge/close/supersede recommendation, and keep all GitHub review and merge actions with the user.
---

# Review PR

## Overview

Use this skill when the user pastes a PR link and wants a security-first assessment before running, testing, or merging it. The goal is to understand the PR intent, inspect the diff, decide whether it is safe to run, and then help with feedback, fixes, merge readiness, or a close recommendation.

This skill is discussion-first, but it should still support fast maintainer throughput. Loading the skill does not authorize guessing which PR to inspect from local branches, refs, or open worktrees. Wait for the user to paste a PR URL, review that one PR, give a concise rundown, and discuss it with the user before taking any local git actions beyond basic repository state checks.

If the maintainer is clearly trying to fly through PRs, keep the discussion short and move quickly to a decisive recommendation:

- `Merge`
- `Close`
- `Supersede with direct fix`

Use `Supersede with direct fix` when the underlying issue is legitimate but the PR implementation is too broad, changes the wrong behavior, or is close but not quite right. In that case, offer to implement the narrower fix locally and draft the close comment for the maintainer.

## Workflow

### 0. Wait for the PR URL

- Do not infer the target PR from local branches such as `pr-*`, from recent git history, or from the current worktree.
- Review one PR at a time, in the order the user pastes them.
- If no PR URL has been pasted in the current discussion, ask for it and stop there.
- After the user pastes a PR URL, read it first and respond with a rundown before fetching refs, checking out branches, or diffing local PR branches.

### 1. Read the PR first

- Read the PR description and discussion before touching the branch.
- Capture the claimed intent, test plan, linked issue, and any mention of permissions, downloads, shell execution, networking, updater behavior, or native code.
- If the description is missing or inaccessible, say so explicitly and continue with the code review.
- The first substantive reply after reading should be a rundown for discussion with the user:
  - what the PR claims to do
  - what parts of the codebase it likely touches
  - which runtime host or VM should be used for build/run/test work
  - obvious security or runtime-risk areas to focus on
  - any missing context or questions
- Do not assume the user wants immediate local branch inspection. Discuss first, then inspect locally if it will materially help the review.
- If the user is clearly in rapid triage mode, keep this rundown to a few lines and then continue with local diff inspection.

### 1.5 Determine the review host before execution advice

- Use the PR title, description, discussion, and changed-file list to infer which OS should be used for runtime verification.
- State this explicitly before recommending any build, run, or test command.
- If the current machine does not match the target runtime, say so clearly:
  - static review can continue on the current machine
  - build/run/manual verification should move to the correct VM or host OS
- Use these common signals:
  - `package/src/native/win/*`, `WebView2`, `DirectComposition`, `D3D11`, `D3D12`, `DXGI`, `HWND`, `.vcxproj`, Windows packaging: review and test on Windows
  - `package/src/native/macos/*`, Cocoa, AppKit, WKWebView, Metal, CAMetalLayer, notarization, `.mm` changes: review and test on macOS
  - `package/src/native/linux/*`, GTK, WebKitGTK, X11, Wayland, Flatpak, `.desktop`, distro packaging: review and test on Linux
  - shared JS/TS/build/config/template changes with no OS-specific runtime path: static review anywhere, but runtime verification may require multiple OSes
  - CI, release, signing, packaging, updater, installer changes: often require an OS matrix, not a single VM
- If the PR description is vague, use the file change list and symbols/imports to infer the target environment anyway.
- If a PR is clearly platform-specific, tell the user to switch to that machine before any execution recommendation.

### 2. Avoid executing untrusted changes too early

- Do not run the PR branch, install dependencies, or execute tests until the diff passes a basic security screen.
- Treat package manager commands as code execution because lifecycle hooks and install scripts may run.
- If execution becomes necessary, state exactly what will run and why.

### 3. Build and test Electrobun the right way

- Never try to build individual parts of Electrobun directly.
- To build local Electrobun changes, run `bun build:dev` from `package/`.
- To fully rebuild Electrobun and run the kitchen sink app, run `bun dev` from `package/`.
- New functionality should generally include kitchen sink coverage. If a useful PR arrives without those tests, it is acceptable to add them locally as part of the review work.
- Some kitchen sink tests are interactive. If verification depends on one of those paths, stop and ask the user to perform the manual check.

### 4. Build the local review surface

- Only do this after the PR URL has been read and the initial rundown/discussion has happened.
- Confirm the current branch and worktree state first.
- Fetch the PR head into a local ref instead of switching branches immediately.
- Prefer non-destructive inspection commands such as:

```bash
git fetch origin pull/<pr-number>/head:pr-<pr-number>
git diff --stat <base-branch>...pr-<pr-number>
git log --oneline --decorate <base-branch>..pr-<pr-number>
git diff <base-branch>...pr-<pr-number>
```

- If the PR base is not `main`, diff against the actual base branch.

### 5. Prioritize the risky parts of the diff

Read high-risk files first:

- package manifests, lockfiles, vendored binaries, generated artifacts
- build, release, CI, installer, updater, or bootstrap scripts
- shell/process execution, filesystem access, environment variable handling
- network requests, remote content loading, analytics, telemetry, auto-update
- auth, permission boundaries, IPC, browser bridges, protocol handlers
- native code, FFI, memory ownership, thread hops, callbacks, string conversion
- templates or starter code that change the default security posture for users

Read tests after you understand the runtime paths they are meant to cover. Tests are evidence of intent, not proof of safety.

### 6. Judge safe-to-run risk

Default to a threat-model mindset. Ask:

- Does this add or widen code execution paths?
- Does it trust new remote input, URLs, downloaded artifacts, env vars, or config?
- Does untrusted data reach a shell, filesystem path, subprocess, protocol handler, or native boundary?
- Does it introduce dynamic loading, eval, plugin behavior, remote scripts, or opaque binaries?
- Does it change signing, packaging, notarization, publishing, or release artifacts?
- Does it create a persistence or exfiltration path through logs, telemetry, updater, or background services?

Treat these as immediate high-scrutiny signals:

- new dependencies, lockfile churn, vendored binaries, or generated code with no clear source
- new install hooks, postinstall scripts, downloaders, or bootstrap scripts
- shell commands built from user input, env vars, filenames, or network data
- auto-update, remote config, analytics, telemetry, or background services
- new protocol handlers, IPC endpoints, browser bridges, or deserialization paths
- native code touching buffers, strings, ownership, callbacks, or thread hops
- release workflow, signing, notarization, packaging, or publishing changes

For dependency changes, treat even small edits as security-sensitive. For native changes, inspect bounds, ownership, lifetime, null handling, conversions, and cross-thread access.

Before recommending that the user run the branch, answer:

- Will any command execute new code during install, build, test, or bootstrap?
- Does the PR introduce a path from untrusted input to code execution?
- Does it widen file access, process spawning, network access, or privilege boundaries?
- Does it add opaque artifacts that cannot be audited from source?
- Does the claimed test coverage actually touch the risky path?

### 6.5 Judge repo fit and maintainer action

Security review is not enough. Also decide whether the PR is actually the right change for Electrobun.

Ask:

- Is the underlying issue legitimate for this repo?
- Does the implementation match existing API semantics and platform expectations?
- Does it introduce unrelated policy or UX behavior beyond the claimed fix?
- Is the change narrower or broader than necessary?
- Would maintaining this behavior create follow-on complexity, docs debt, or compatibility risk?

Then make an explicit maintainer recommendation:

- `Merge` when the issue is real, the implementation is aligned, and the risk is acceptable.
- `Close` when the issue is not compelling, the implementation is wrong for the repo, or the change is not worth taking.
- `Supersede with direct fix` when the idea is good but the implementation is too broad, subtly wrong, or missing the minimal repo-appropriate fix.

For `Supersede with direct fix`:

- say clearly that the PR is close but not mergeable as written
- offer to implement the narrow fix locally
- if the user wants speed, go ahead and implement the narrow fix unless blocked
- provide a short close comment the maintainer can paste, ideally one paragraph or a one-liner

## Electrobun Hotspots

For this repo, pay extra attention to:

- `package/src/native/*`: platform wrappers, callback lifetimes, memory and permission handling
- `package/src/cli/*`, `scripts/*`, `BUILD.md`: shell execution, quoting, packaging, release flow
- `package/package.json`, template manifests, lockfiles: dependency trust and lifecycle hooks
- `.github/workflows/*`: secret exposure, artifact tampering, release automation
- `templates/*`: defaults that downstream apps will inherit
- `package/src/bun/*` and protocol or IPC code: trust boundaries and message validation

## Output Format

Lead with the verdict, not style commentary.

Use one of these verdicts:

- `Safe to run as-is`
- `Probably safe to run with caveats`
- `Not safe to run until fixed`
- `Unable to verify safely`

Then structure the response as:

- `Verdict:` one line
- `Review host:` which OS/VM should be used for runtime verification, and whether the current machine is enough for static review only
- `Rundown:` short explanation of the PR intent and likely review focus
- `Findings:` ordered by severity with exact file references and the concrete exploit or failure mode
- `Questions:` only if unresolved assumptions affect safety
- `Next move:` explicit maintainer action: `Merge`, `Close`, or `Supersede with direct fix`, followed by the short reasoning

If there are no findings, say that explicitly and note any residual risk or untested area.

Call out residual risk when:

- native code changed but was not exercised
- dependency or lockfile changes were not independently audited
- release, signing, or CI changes were reviewed statically only
- templates or starter code changed in ways that downstream users may not notice

## After The Review

- Do not leave the maintainer with an open-ended answer when a clear recommendation is possible.
- Make the merge/close/supersede call explicitly.
- If the user wants tweaks, make the smallest defensible changes that close the risk without changing the PR intent unnecessarily.
- If the PR is close but not correct, prefer a narrow local fix over extended back-and-forth.
- When superseding a PR, implement only the minimal repo-appropriate change and avoid dragging in the PR's extra behavior.
- For close recommendations, draft the shortest useful close comment. A one-liner is acceptable when the reason is straightforward.
- Re-diff or re-test the touched area before recommending merge.
- Never write to the PR itself.
- The user is the only person who reviews local changes, creates commits, pushes to GitHub, leaves GitHub review comments, or merges through the GitHub UI.
