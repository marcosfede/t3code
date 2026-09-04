---
name: sync-upstream
description: Keep this fork (marcosfede/t3code, branch devin) rebased on pingdotgg/t3code main. Use to check whether the fork is current, diagnose a failed "Sync upstream" workflow run, resolve rebase conflicts by hand in a throwaway worktree, verify, push, and bring a local checkout back in line. Also covers the fork's workflow-strip commit and where new fork commits go.
argument-hint: "[status|sync|local]"
---

# Sync the fork with upstream

## How the fork is laid out

- `upstream` = `git@github.com:pingdotgg/t3code.git`, branch `main`. Read-only for us.
- `origin` = `git@github.com:marcosfede/t3code.git`. The only branch that matters is **`devin`**.
  `origin/main` is an abandoned mirror; ignore it or delete it, never push to it.
- `devin` = `upstream/main` + a short stack of fork commits (Devin CLI / Devin Cloud providers, PostHog off,
  fork release workflow, this sync tooling), then **one trailing commit `ci(fork): drop upstream workflows`**
  ("the strip commit") that deletes every file in `.github/workflows/` except `release-fork.yml` and
  `sync-upstream.yml`.
- The strip commit exists because the fork does not run upstream's workflows (they need upstream's secrets and
  runners), and because the default `GITHUB_TOKEN` may not push changes under `.github/workflows/`. The sync
  removes the strip commit, rebases, and recreates it, so the workflow directory never changes between pushes
  and no PAT is needed. **Never re-add upstream workflow files, never add a PAT, never mirror `main`.**
- `.github/workflows/sync-upstream.yml` runs daily (06:17 UTC) and on `workflow_dispatch`. A run fails only
  when `devin` does not rebase cleanly; then a human (or you) resolves it with the manual procedure below.

## Check status

```bash
git fetch upstream main && git fetch origin devin
git rev-list --left-right --count origin/devin...upstream/main   # "<fork-only> <behind>"; behind must be 0
gh run list -R marcosfede/t3code --workflow sync-upstream.yml --limit 5
```

If the latest run failed, read its log for `CONFLICT` lines to see which fork commit and files collide:
`gh run view <id> -R marcosfede/t3code --log-failed | rg "CONFLICT|Could not apply"`.

## Manual sync (when the workflow reports a conflict)

Work in a detached throwaway worktree. The developer's checkout often has uncommitted work from another agent,
and `git rebase` must not run there.

```bash
git fetch upstream main && git fetch origin devin
git worktree add --detach /tmp/t3-sync origin/devin
cd /tmp/t3-sync
git rebase --onto HEAD^ HEAD          # drop the strip commit (verify HEAD was "ci(fork): drop upstream workflows" first)
git rebase upstream/main              # resolve conflicts; `git add -A && GIT_EDITOR=true git rebase --continue`
```

Conflict hot spots and how to resolve them:

- **Provider registration lists** (`packages/contracts/src/settings.ts`, `apps/web/src/session-logic.ts`,
  `apps/web/src/components/chat/providerIconUtils.ts`, `apps/web/src/components/settings/providerDriverMeta.ts`,
  `apps/server/package.json`, `pnpm-lock.yaml`): upstream adds a provider or dependency at the same spot our
  Devin entries live. Keep **both**, upstream's entry first, ours after. When two schemas interleave inside one
  conflict block, rewrite them as two complete sequential blocks.
- **`apps/server/src/provider/acp/AcpSessionRuntime.ts`**: the fork splits transport setup into a `spawn`
  branch and a `webSocket` branch (Devin Cloud) and exposes `awaitTermination`. Upstream keeps editing the
  spawn path (stderr handling, termination tracking). Take upstream's mechanism, apply its spawn-path edits
  inside our spawn branch, keep the WebSocket branch, and feed `awaitTermination` from upstream's
  `recordTermination`. Any per-transport teardown belongs on the `transport.terminate` effect.
- **`apps/server/scripts/acp-mock-agent.ts`**: keep upstream's profile hooks and our
  `T3_ACP_EXIT_AFTER_SESSION_MS` hook side by side.
- If upstream already implements what a fork commit does, prefer upstream's version and shrink ours.

Verify in the worktree (do not run repo-wide checks):

```bash
vp i
vp run --filter t3 typecheck && vp run --filter @t3tools/contracts typecheck && vp run --filter @t3tools/web typecheck
vp test run apps/server/src/provider/Layers/DevinAdapter.test.ts \
  apps/server/src/provider/acp/DevinAcpSupport.test.ts \
  apps/server/src/provider/acp/AcpWebSocketStdio.test.ts \
  packages/effect-acp/src/client.test.ts
vp check <files you hand-edited>
```

Known failures that are not ours: `AntigravityAdapter.test.ts` "serves client file reads and writes only inside
the session roots" fails on macOS on pristine upstream (`/var/folders` symlink);
`ProviderRegistry.test.ts` has two hard-coded provider lists that predate our `devin`/`devinCloud` entries.

Recreate the strip commit and push:

```bash
for p in .github/workflows/*; do case "$(basename "$p")" in release-fork.yml|sync-upstream.yml) ;; *) git rm -q "$p";; esac; done
git -c core.hooksPath=/dev/null commit -q -m "ci(fork): drop upstream workflows"
git push --force-with-lease=devin:origin/devin origin HEAD:devin
gh workflow run sync-upstream.yml -R marcosfede/t3code --ref devin    # prove the automated run is green again
cd - && git worktree remove --force /tmp/t3-sync
```

If new conflicts appear in the automated run right after your push, upstream landed more commits while you
worked; repeat.

## Bring a local checkout up to date

The sync force-pushes `devin`, so never plain `git pull`. With a clean tree:
`git fetch origin && git checkout devin && git reset --hard origin/devin`. With uncommitted work, commit it
first, then `git rebase --onto origin/devin <old-origin-devin-sha>`, or stash and reset.

## Adding fork commits

Commit normally on `devin`; the next sync handles ordering by removing the strip commit wherever it sits. Avoid
touching `.github/workflows/` in fork commits other than the two fork-owned files. Fork commits use
`ci(fork):` / `chore(fork):` prefixes when they are fork housekeeping so they are easy to tell apart from
product work in `git log upstream/main..devin`.
