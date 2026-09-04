---
name: sync-upstream
description: Keep this fork (marcosfede/t3code, branch devin) rebased on pingdotgg/t3code main. Use to check whether the fork is current, diagnose a failed "Sync upstream" workflow run, resolve rebase conflicts by hand in a throwaway worktree, verify, push, ship a desktop build of the result via the fork release workflow without racing the sync, update the locally installed T3 Code app, and bring a local checkout back in line. Also covers the fork's workflow-strip commit and where new fork commits go.
argument-hint: "[status|sync|release|install|local]"
---

# Sync the fork with upstream

A full sync run means all three, in order; stop and report if any step cannot be completed:

1. **Code**: `origin/devin` and the local checkout are rebased on the latest `upstream/main`, with the fork commits
   on top and the strip commit last. Sections: Check status, Manual sync, Bring a local checkout up to date.
2. **Build**: a fork desktop release `v<upstream>-fork.<N>` built from that exact `devin` tip. Section: Ship a
   desktop build.
3. **Install**: the developer's installed T3 Code app can see that release. Section: Update the local T3 install.

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
worked; repeat. Once the automated run is green, continue with the desktop build below; the automated daily sync
does not build anything.

## After a sync: ship a desktop build

A sync is not finished until a desktop build of the new `devin` exists. `.github/workflows/release-fork.yml`
builds unsigned Linux x64 + macOS arm64 artifacts (about 6 minutes) and publishes them as a GitHub Release on
the fork. Packaged builds carry an `app-update.yml` pointing at `marcosfede/t3code`, so installed CI builds
self-update from these releases.

**Versioning: `<upstream version>-fork.<N>`**, for example `0.0.38-fork.1`, then `0.0.38-fork.2` after another
sync that is still on upstream `0.0.38`, then `0.0.39-fork.1` once upstream bumps. The upstream version is the
`version` field of `apps/desktop/package.json` at the synced commit. This is the semver spelling of "x.y.z plus a
fork revision": a literal fourth component (`0.0.38.1`) is not valid semver and electron-updater cannot compare it,
so self-update would break. Prerelease identifiers compare numerically, so `fork.10 > fork.9`, and
`0.0.39-fork.1 > 0.0.38-fork.9`. The fork's "latest" update channel is unaffected by the suffix: electron-updater
takes GitHub's Latest release and compares with `semver.gt`, and `resolveDesktopUpdateChannel` only treats
`-nightly.` as a separate channel. Never publish a fork build as a GitHub pre-release.

```bash
git fetch origin devin
base=$(git show origin/devin:apps/desktop/package.json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')
n=$(( $(gh release list -R marcosfede/t3code --limit 100 --json tagName --jq "[.[] | select(.tagName | startswith(\"v${base}-fork.\"))] | length") + 1 ))
version="${base}-fork.${n}"
```

**Race condition.** The release workflow builds and tags `github.sha`, the tip of `devin` at dispatch time. If
`devin` is force-pushed while it runs (the daily sync at 06:17 UTC, a manual sync, or another agent), that commit
drops out of the branch history and the release points at an orphan, or the checkout fails. So:

```bash
gh run list -R marcosfede/t3code --workflow sync-upstream.yml --status in_progress   # must print nothing
gh run list -R marcosfede/t3code --workflow sync-upstream.yml --status queued        # must print nothing
sha=$(git rev-parse origin/devin)
gh workflow run release-fork.yml -R marcosfede/t3code --ref devin -f version="$version"
sleep 10 && id=$(gh run list -R marcosfede/t3code --workflow release-fork.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$id" -R marcosfede/t3code --exit-status
# verify the release points at the commit you built and that it is still on devin
target=$(gh release view "v$version" -R marcosfede/t3code --json targetCommitish --jq .targetCommitish)
[ "$target" = "$sha" ] && git merge-base --is-ancestor "$sha" origin/devin && echo ok
```

Do not push to `devin` or dispatch a sync until `gh run watch` returns. Avoid dispatching within a few minutes of
06:17 UTC. If the check fails, delete and rebuild: `gh release delete "v$version" -R marcosfede/t3code --cleanup-tag -y`,
then dispatch again once `devin` is quiet.

Legacy: `v0.1.0` (2026-08-14) predates this scheme. It is higher than every `0.0.x-fork.N`, so any app still
running it will not self-update; nobody is known to run it. Delete it only with the developer's say-so.

## Update the local T3 install

The desktop app bundles the server, so updating the app updates both. The fork does not publish `npx t3` to npm.

- Installed app: `/Applications/T3 Code (Alpha).app`. Version:
  `defaults read "/Applications/T3 Code (Alpha).app/Contents/Info.plist" CFBundleShortVersionString`.
- If `Contents/Resources/app-update.yml` exists, it is a CI build and self-updates: the app picks up the new release
  on its next check, or use the in-app update action. Nothing else to do.
- If that file is missing, the app was built locally and cannot self-update; the in-app check shows "Automatic
  updates are not available because no update feed is configured". Replace it once with the CI build; afterwards it
  self-updates:

  ```bash
  gh release download "v$version" -R marcosfede/t3code -p "T3-Code-${version}-arm64.dmg" -D /tmp/t3-release --clobber
  hdiutil attach "/tmp/t3-release/T3-Code-${version}-arm64.dmg" -nobrowse -mountpoint /Volumes/T3Code
  rm -rf "/Applications/T3 Code (Alpha).app" && cp -R "/Volumes/T3Code/T3 Code (Alpha).app" /Applications/
  hdiutil detach /Volumes/T3Code
  xattr -dr com.apple.quarantine "/Applications/T3 Code (Alpha).app"   # unsigned build
  ```

  The app must be quit before it is replaced, and the developer is often driving you from it. Ask before quitting
  it, and never kill it by pattern. User data lives in `~/Library/Application Support/T3 Code (Alpha)` and
  `~/.t3`, which the reinstall does not touch.

## Bring a local checkout up to date

The sync force-pushes `devin`, so never plain `git pull`. With a clean tree:
`git fetch origin && git checkout devin && git reset --hard origin/devin`. With uncommitted work, commit it
first, then `git rebase --onto origin/devin <old-origin-devin-sha>`, or stash and reset.

## Adding fork commits

Commit normally on `devin`; the next sync handles ordering by removing the strip commit wherever it sits. Avoid
touching `.github/workflows/` in fork commits other than the two fork-owned files. Fork commits use
`ci(fork):` / `chore(fork):` prefixes when they are fork housekeeping so they are easy to tell apart from
product work in `git log upstream/main..devin`.
