---
name: sync-upstream
description: Maintain the marcosfede/t3code fork on branch devin. Use to check or sync upstream, resolve rebase conflicts, commit and push fork changes, monitor automatic versioned desktop releases, or troubleshoot in-product updates. Every push to devin builds a new fork release in CI; recent self-signed installs update in-product after the certificate has been approved. Do not rebase upstream or replace the installed app merely to ship a commit.
argument-hint: "[status|sync|release|updates|local]"
---

# Sync and release the fork

## Choose the requested scope

- **Commit and push / ship a fix:** commit on `devin`, push to `origin/devin`, and check the automatic release run. Do not add an upstream rebase or local app replacement to this request.
- **Sync upstream:** rebase the fork onto the latest `upstream/main`, preserving the fork commits and trailing workflow-strip commit, then verify the automatic desktop release of the resulting tip.
- **Release only:** use the existing automatic run for the pushed commit. Dispatch `release-fork.yml` only when a run is missing or a fresh rebuild is needed.
- **Update the app:** the developer normally downloads and installs the published release through T3 Code's in-product updater. Publishing the release is the agent's normal handoff; do not quit or replace their running app.

A local commit alone cannot trigger GitHub CI. Every push to `devin` starts a release for that push's tip, including documentation-only changes. A push containing several commits builds their combined tip, not each intermediate commit. Do not commit package-version bumps: CI assigns the release version and updates package versions only in its build workspace.

## How the fork is laid out

- `upstream` = `git@github.com:pingdotgg/t3code.git`, branch `main`. Read-only for us.
- `origin` = `git@github.com:marcosfede/t3code.git`. Its default and only maintained branch is **`devin`**. Do not create a `main` mirror.
- `devin` contains upstream plus the fork commits (Devin providers, PostHog off, fork release and sync tooling), and one commit titled **`ci(fork): drop upstream workflows`**. The strip commit deletes every upstream workflow except the fork-owned `release-fork.yml` and `sync-upstream.yml`.
- New fork commits can go above the strip commit. The next sync removes that strip commit, rebases, and recreates it last. The workflow directory consequently stays unchanged across the sync's push, so no PAT is needed. Never re-add upstream workflows or introduce a PAT to work around workflow permissions.
- `sync-upstream.yml` runs daily at 06:17 UTC and on manual dispatch.
- `release-fork.yml` runs on pushes to `devin`, successful **Sync upstream** completion, and manual dispatch. The `workflow_run` trigger is necessary because pushes made with `GITHUB_TOKEN` do not trigger push workflows.

## Check status

```bash
git fetch upstream main && git fetch origin devin
git rev-list --left-right --count origin/devin...upstream/main
gh run list -R marcosfede/t3code --workflow sync-upstream.yml --limit 5
gh run list -R marcosfede/t3code --workflow release-fork.yml --limit 5
gh release list -R marcosfede/t3code --limit 10
```

The second number from `rev-list` is the number of upstream commits missing from the fork. It must be zero after a requested sync, but it is not a reason to rebase when the request is only to ship a fix.

For failed syncs, read `gh run view <id> -R marcosfede/t3code --log-failed` and identify the conflicting commits and files.

## Manual sync when the workflow conflicts

Use a detached throwaway worktree, not the developer's checkout. Confirm permission before rewriting history and force-pushing. Manual git operations do not participate in the CI concurrency queue: first ensure no release or sync is running or queued, and do not start one while resolving the rebase.

```bash
git fetch upstream main && git fetch origin devin
git worktree add --detach /tmp/t3-sync origin/devin
```

In that worktree, find exactly one strip commit:

```bash
strip=$(git log --format=%H --grep='^ci(fork): drop upstream workflows$' upstream/main..HEAD)
git rebase --onto "$strip^" "$strip"
git rebase upstream/main
```

Conflict hot spots:

- **Provider registration lists** (`packages/contracts/src/settings.ts`, `apps/web/src/session-logic.ts`, provider icon/settings metadata, `apps/server/package.json`, `pnpm-lock.yaml`): retain both upstream additions and Devin entries, upstream first. Keep schemas as complete sequential definitions.
- **`apps/server/src/provider/acp/AcpSessionRuntime.ts`**: preserve the fork's spawn/WebSocket split and `awaitTermination`; integrate upstream spawn changes inside the spawn branch and feed termination from `recordTermination`. Teardown belongs on the transport's termination effect.
- **`apps/server/scripts/acp-mock-agent.ts`**: retain upstream profile hooks alongside the fork's `T3_ACP_EXIT_AFTER_SESSION_MS` hook.
- Prefer upstream's implementation when it supersedes a fork fix.

Resolve conflicts, stage only the resolved files, and continue with `GIT_EDITOR=true git rebase --continue`. Verify in the worktree without repo-wide checks:

```bash
vp i
vp run --filter t3 typecheck
vp run --filter @t3tools/contracts typecheck
vp run --filter @t3tools/web typecheck
vp test run apps/server/src/provider/Layers/DevinAdapter.test.ts apps/server/src/provider/acp/DevinAcpSupport.test.ts apps/server/src/provider/acp/AcpWebSocketStdio.test.ts packages/effect-acp/src/client.test.ts
vp check <files-you-hand-edited>
```

Known unrelated failures: Antigravity's session-root file-access test fails on pristine upstream on macOS because of the `/var/folders` symlink; some ProviderRegistry tests have hard-coded lists predating the fork providers. Verify findings against the current source rather than assuming every failure is known.

Recreate the strip commit by removing upstream workflows while retaining `release-fork.yml` and `sync-upstream.yml`, then commit normally with hooks enabled. After the explicitly approved force-push, the push-triggered release starts automatically:

```bash
git push --force-with-lease=devin:origin/devin origin HEAD:devin
```

If requested, dispatch the automated sync to prove it is green again. It queues safely behind an active release and schedules its own release after success:

```bash
gh workflow run sync-upstream.yml -R marcosfede/t3code --ref devin
```

Do not delete the worktree until it is clean and no longer needed. Ask before destructive cleanup.

## Automatic desktop releases

The workflow builds unsigned Linux x64 AppImage and self-signed macOS arm64 DMG/ZIP assets, then publishes a normal GitHub Release on this fork. Packaged builds carry `app-update.yml` pointing at `marcosfede/t3code`.

### Versioning and ordering

- Format: **`<desktop package version>-fork.<N>`**, for example `0.0.40-fork.3`.
- CI reads `apps/desktop/package.json` at the selected commit and chooses one greater than the highest existing numeric `v<base>-fork.N` tag. It does not count releases, so gaps and revisions above 9 are handled correctly. A new upstream base starts at `fork.1`.
- Failed builds that never created a tag do not consume a revision. Manual version overrides must use the selected base and a revision higher than all existing tags for that base.
- Do not use a fourth numeric version component, a hash as the version, or GitHub's pre-release flag. Numeric `fork.N` identifiers are semver-orderable, and the in-product updater uses the fork's Latest release.
- Both workflows share the `fork-delivery` concurrency group with `queue: max`. GitHub queues up to 100 waiting runs rather than replacing the pending release when another push arrives. CI sync cannot rebase the branch during a release.
- Push/manual releases select the triggering commit. Post-sync releases resolve the current `devin` tip, not the sync run's pre-rebase `head_sha`. Every build job and the published tag use the resolved SHA.
- Commits already removed by a rebase are skipped; the post-sync release carries their rebased changes. A release is marked Latest only if its SHA still matches `devin` at publication. Older queued commits can publish downloadable assets without replacing the update feed for the current tip.

### Verify workflow changes

Run `vp test run scripts/release-fork.test.ts` for version allocation and publication behavior, plus targeted formatting and workflow validation. `actionlint` v1.7.12 predates GitHub's documented `queue: max` property; validate that property against GitHub's concurrency documentation and disregard only that specific unsupported-key diagnostic locally, not other workflow errors. Do not remove the queue to satisfy the older validator.

### Monitor and hand off

For a normal pushed commit, find its run:

```bash
sha=$(git rev-parse HEAD)
gh run list -R marcosfede/t3code --workflow release-fork.yml --commit "$sha" --limit 5
```

For a post-sync run, inspect the **Resolve version** output: its resolved build SHA can differ from the workflow event's `headSha`.

```bash
gh run watch <run-id> -R marcosfede/t3code --exit-status
gh release view <release-tag> -R marcosfede/t3code --json url,tagName,targetCommitish,isDraft,isPrerelease,assets
gh api repos/marcosfede/t3code/releases/latest --jq .tag_name
```

Verify the release targets the intended commit, contains both platforms' artifacts and updater metadata, and is neither draft nor pre-release. Confirm it is Latest before saying the in-product update is available. Report the version and release/run link; if still queued or building, say so rather than claiming it is published.

A missing run or requested fresh rebuild can be dispatched without choosing a version:

```bash
gh workflow run release-fork.yml -R marcosfede/t3code --ref devin
```

Avoid duplicate dispatches when an automatic run already exists. An explicit override is available with `-f version=0.0.40-fork.3`, but automatic allocation is preferred. If a release fails, inspect its failed logs and retry only after understanding the cause; do not delete releases/tags without permission.

If tooling is missing on a runner, compare the fork workflow with `git show upstream/main:.github/workflows/release.yml`. The fork strips that upstream file, so build-prerequisite changes must be ported deliberately to `release-fork.yml`. Never weaken signing verification or package-manager security controls to make a build pass.

## In-product updates and signing

**Normal path:** the developer already has a recent self-signed fork release installed and has approved its self-signed certificate. New releases signed with the same identity can be downloaded and installed from inside T3 Code. Updating the desktop app also updates its bundled server; this fork does not publish `npx t3` to npm.

Do not manually replace `/Applications/T3 Code (Alpha).app`, remove updater caches, change certificate trust, or quit the app as part of a normal commit/release workflow. Leave the download/restart to the developer unless they explicitly request help.

### One-time setup or recovery only

An old ad-hoc install, an unapproved certificate, or a local build without `Contents/Resources/app-update.yml` may need manual migration. Have the developer install a recent self-signed fork release and approve the certificate/Gatekeeper prompt. Ask before quitting or replacing their app. Never touch user data in `~/.t3` or `~/Library/Application Support/t3code`.

Read-only checks:

```bash
defaults read "/Applications/T3 Code (Alpha).app/Contents/Info.plist" CFBundleShortVersionString
codesign -dv "/Applications/T3 Code (Alpha).app"
```

The persistent signing identity is **`T3 Code Fork (marcosfede)`**, provisioned in Actions on 2026-09-06 as `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD`. Its backup is under `~/.config/t3code-fork-signing/`, outside the repository. Reuse it; do not regenerate the certificate, print the backup contents, or replace secrets casually. A different certificate can prevent existing installs from accepting updates.

CI imports and trusts the certificate on its disposable runner, signs through `T3CODE_MACOS_SELF_SIGN_IDENTITY`, and verifies the final update ZIP. Self-signing does not provide Apple notarization or Apple-only passkey entitlements. The developer has confirmed in-product updates work once the initial installation and certificate approval are complete; routine releases do not need to repeat that migration exercise.

## Bring a local checkout up to date after a sync

The sync force-pushes `devin`, so never blindly `git pull`. Inspect status and preserve uncommitted work first. With a clean checkout, obtain explicit approval before resetting local `devin` to `origin/devin`. With unpublished commits, preserve and rebase them onto the new remote tip instead of discarding them.

## Adding fork commits

Commit normally on `devin`, with the project's conventional commit style; use `ci(fork):` or `chore(fork):` for fork housekeeping. Only edit the fork-owned workflow files. Push when asked, then verify the automatic release run for the commit. A commit-and-push task should not silently stop before checking that CI picked up the new versioned build.
