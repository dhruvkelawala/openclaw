---
name: openclaw-fork-update
description: Update the local OpenClaw ACP fork onto either an upstream release tag or upstream/main while keeping the patchset small, reviewable, and easy to maintain.
---

# OpenClaw Fork Update Skill

Use this skill when refreshing the local OpenClaw fork/PR that carries the ACP plugin-runtime patch.

## Goals

- keep the fork delta minimal and upstreamable
- prefer replaying a tiny patchset on top of upstream
- support two modes:
  - **release mode**: build on a released tag like `v2026.4.10`
  - **main mode**: build on `upstream/main`
- avoid accidental debug/log churn in the fork
- keep downstream `task-dispatch` working after ACP runtime/config changes

## Current upstream work to preserve

Current PR:

- PR: `https://github.com/openclaw/openclaw/pull/80008`
- Branch: `pr/acp-plugin-runtime-v2`

Preserve the ACP runtime patchset, but adapt it to current upstream code instead of blindly keeping old hunks:

1. plugin SDK runtime exposes ACP helpers for trusted plugins:
   - `api.runtime.acp.spawn()`
   - `api.runtime.acp.prompt()`
2. ACP runtime trust is **per plugin**, not global:
   - current config: `plugins.entries.<pluginId>.acp.allowSpawn: true`
   - retired/old config: `plugins.allowAcpSpawn`
3. `api.runtime.acp` must be scoped through the caller plugin identity.
4. ACP prompt gateway calls must carry `acpTurnSource: "manual_spawn"`.
5. ACP spawn DTO/types/constants should stay in a small leaf contract module to avoid import cycles:
   - `src/agents/acp-spawn-contract.ts`
6. tests/config/docs/changelog should move with behavior changes.

Historical links only if needed for context:

- Old PR: `https://github.com/openclaw/openclaw/pull/63176`
- Old issue: `https://github.com/openclaw/openclaw/issues/65022`

## Preflight

Run in the OpenClaw fork repo:

```bash
pnpm docs:list || true
git status --short
git fetch upstream --tags
git branch --show-current
git log --oneline -1
```

If the tree is dirty, stop and decide whether to commit, restore, or move those changes first. Never fabricate commit hashes; verify with `git log --oneline -1`.

## Mode A: update onto an upstream release tag

Use this when you want the fork to track a stable release.

Example:

```bash
git fetch upstream --tags
git checkout -b fork/v2026.4.10-acp upstream/v2026.4.10
```

Then replay the patchset:

```bash
git cherry-pick <commit1> <commit2> <commit3>
```

If you also need a not-yet-merged upstream fix, cherry-pick that commit separately and document why.

## Mode B: update onto upstream/main

Use this when validating against the latest upstream behavior or when the user explicitly asks for latest `main`.

Preferred flow if the PR branch already exists:

```bash
git fetch upstream
git checkout pr/acp-plugin-runtime-v2
git rebase upstream/main
```

If conflicts are messy, create a fresh branch from `upstream/main` and cherry-pick the small patchset instead of fighting a long rebase.

## Conflict strategy

- keep the fork surface tiny
- never carry temporary debug logging
- if upstream already added equivalent behavior, drop your local hunk
- prefer adapting tests/types over widening the patch
- avoid core/runtime compatibility fallbacks for retired ACP config; use config migration/doctor paths when needed
- do not reintroduce a global ACP spawn gate
- preserve owner boundaries: task-dispatch-specific behavior/config belongs in task-dispatch or local operator config, not OpenClaw core

## Local task-dispatch config migration

After the fork patch changes ACP trust semantics, make sure local operator config has opted task-dispatch in explicitly.

Check both CLI and service config paths:

```bash
pnpm openclaw gateway status
```

Look for:

- `Config (cli): ...`
- `Config (service): ...`

If they differ, update both configs or reinstall the gateway from the intended profile/state-dir. The task-dispatch entry should contain:

```json
{
  "plugins": {
    "entries": {
      "task-dispatch": {
        "acp": {
          "allowSpawn": true
        }
      }
    }
  }
}
```

Remove old global config if present:

```json
{
  "plugins": {
    "allowAcpSpawn": true
  }
}
```

## Verification

After replaying the patchset, run targeted local proof first:

```bash
pnpm test src/plugins/runtime/index.test.ts src/config/config-misc.test.ts src/plugins/config-state.test.ts src/plugins/status.test.ts src/config/schema.help.quality.test.ts
pnpm check:architecture
pnpm tsgo:prod
pnpm build
pnpm openclaw config validate
```

Then validate the downstream task-dispatch plugin if available:

```bash
cd ~/.openclaw/extensions/task-dispatch
bun run typecheck
bun run build:plugin
```

If downstream ACP thread behavior matters, also live-validate through the gateway:

1. rebuild OpenClaw (`pnpm build`)
2. restart gateway
3. run `pnpm openclaw gateway status`
4. run `pnpm openclaw gateway health`
5. dispatch a task via `task-dispatch`
6. confirm:
   - ACP session starts
   - Discord thread binding persists
   - follow-up replies continue the same session

## Gateway restart/debug gotchas

If OpenClaw seems broken after a rebase/build:

- stale hashed `dist/*` chunks can break lazy gateway imports; symptoms include websocket close `1011` and `gateway message handler unavailable`
- rebuild before restart: `pnpm build`
- check whether CLI and service configs differ with `pnpm openclaw gateway status`
- service logs are usually more useful than the CLI error:
  - `./scripts/clawlog.sh`
  - `~/Library/Logs/openclaw/gateway.log`
  - `~/Library/Logs/openclaw/gateway.err.log`
- `pnpm openclaw gateway restart --force` can clear a stale pid
- `pnpm openclaw gateway install --force` can refresh the LaunchAgent, but verify the service actually starts afterward
- on macOS, if launchd repeatedly logs `Operation not permitted` for the service env wrapper, inspect the LaunchAgent/service-env paths and xattrs; avoid relying on a blocked symlinked wrapper path
- if task-dispatch ACP sessions fail with `Authentication required`, check the LaunchAgent environment, not just OpenClaw config:
  - launchd does not source `~/.profile`
  - `PATH` must include `/opt/homebrew/bin` so `npx`, `pi`, and `opencode` are visible
  - provider keys used by ACP harnesses, e.g. `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `MINIMAX_API_KEY`, must be present in the service env/plist with values redacted in logs

Healthy proof should include:

```text
Runtime: running
Connectivity probe: ok
Capability: admin-capable
```

and:

```text
Gateway Health
OK
```

## PR update workflow

Once the branch is verified:

```bash
git push --force-with-lease origin HEAD:pr/acp-plugin-runtime-v2
```

Then update the PR with:

- what upstream base was used (`tag` or `upstream/main`)
- the verified latest commit hash
- what local commits were replayed/adapted
- what downstream validation was run, especially task-dispatch proof
- whether any extra temporary cherry-picks were needed
- migration note for operators: `plugins.allowAcpSpawn` → `plugins.entries.<id>.acp.allowSpawn`

If the PR has a Real behavior proof check, keep that section current and concrete.

## Maintenance rules

- downstream plugin fixes belong in the downstream repo, not the fork
- OpenClaw UX follow-ups should become upstream issues, not fork-only tweaks
- if a fork change is not required for `api.runtime.acp.*`, remove it
- prefer reopening/rebasing the same PR instead of creating many competing PRs
- before declaring done, confirm task-dispatch still has per-plugin ACP trust in the active config

## Recommended branch naming

- release based: `fork/vYYYY.M.D-acp`
- main based: `pr/acp-plugin-runtime-v2`

## Quick decision guide

- need stability? use **release mode**
- need latest upstream fixes? use **main mode**
- need both? validate on `upstream/main`, then decide whether to backport only the necessary subset onto the release-tag branch
