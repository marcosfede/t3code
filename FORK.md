# Fork spec: marcosfede/t3code

This fork is upstream [pingdotgg/t3code](https://github.com/pingdotgg/t3code) plus the features below. This file is the contract. The fork's code is whatever it takes to keep these invariants true on the current upstream base. Upstream can rewrite anything, and fork code can be rebuilt, simplified or deleted, as long as every invariant still holds.

Rules:

- When syncing, refactoring or simplifying, check every invariant. "Check" names the focused test that enforces an invariant, or the manual step when no test exists yet.
- Prefer upstream's implementation whenever it satisfies an invariant. Keep the fork's diff as small as the invariants allow.
- Adding, changing or dropping an invariant is a product decision for the maintainer. Do it in this file, in the same change as the code.

## Delivery

- **D1 Fork releases.** Every push to `devin` builds and publishes a GitHub Release on this fork: an unsigned Linux x64 AppImage, a self-signed macOS arm64 DMG and ZIP, and updater metadata. The version is `<desktop version>-fork.<N>`, with N one above the highest existing tag for that base. Check: `scripts/release-fork.test.ts`, `scripts/build-desktop-artifact.test.ts`, and the release run after a push.
- **D2 In-product updates.** Packaged builds update from this fork's Latest release, signed with the persistent `T3 Code Fork (marcosfede)` identity, so existing installs accept new releases. Check: the release's `app-update.yml` points at `marcosfede/t3code`, and the release is Latest.
- **D3 Fork-only CI.** `.github/workflows` contains only `release-fork.yml` and `sync-upstream.yml`, removed and re-added as one trailing `ci(fork): drop upstream workflows` commit around each rebase. Check: `ls .github/workflows`.
- **D4 Daily upstream sync.** `sync-upstream.yml` rebases `devin` onto `upstream/main` daily and on dispatch. A conflict fails the run for manual resolution with `.devin/skills/sync-upstream`. Check: latest Sync upstream run.

## Privacy

- **P1 Telemetry off by default.** Server analytics are disabled unless `T3CODE_TELEMETRY_ENABLED=true`. Check: default in `apps/server/src/telemetry/AnalyticsService.ts`.

## Devin

- **V1 Local Devin is upstream's.** The local `devin acp` agent comes from upstream's ACP Registry provider (`agentId: devin`). The fork adds no local Devin provider. Check: no fork driver for local Devin; the registry lists Devin.
- **V2 Devin Cloud provider.** A `devinCloud` provider runs remote Devin sessions through the Devin CLI (`devin acp --cloud`). Auth comes from `devin auth login`. A leftover legacy `credentialsPath` gives a clear error telling the user to log in with the CLI. Check: `apps/server/src/provider/Layers/DevinCloudProvider.test.ts`.
- **V3 Health without side effects.** The provider status probe checks the CLI version, `devin auth status` and ACP `initialize`, and never creates a Cloud session. Check: `DevinCloudProvider.test.ts`.
- **V4 Models.** The model list comes from the Cloud session's config options, with a fallback list and a `devin-cloud-default` alias. Check: `DevinCloudProvider.test.ts`, `packages/contracts/src/settings.test.ts`.
- **V5 Organization.** The provider settings have an organization picker that loads the account's organizations when opened, and threads can override it. The organization is read-only after a thread's session starts, on web and mobile. Check: `apps/web/src/components/settings/ProviderSettingsForm.test.ts`, `apps/web/src/components/chat/TraitsPicker.test.ts`, `DevinCloudAcpSupport.test.ts`.
- **V6 Clean transcript.** A Cloud turn shows exactly one user message with the user's text. T3's injected wrappers (`<t3_code_instructions>`, `<runtime_info>`, `<pull_request_linking>`, `<user_request>`) are never shown. Devin's citation markup is rewritten into readable references. Check: `apps/server/src/provider/acp/DevinReferences.test.ts`, `DevinCloudAcpSupport.test.ts`.
- **V7 Reconnect mid-turn.** If the CLI connection drops during a turn, the server reconnects to the same Cloud session: up to 4 retries, each capped at 20 s. Replayed events are de-duplicated by `cognition.ai/eventId`. A prompt that failed before it was sent is resent. A turn that finished during the outage settles from the replayed status. The turn does not fail. Cancelling waits for Cloud's post-cancel idle state. Check: `apps/server/src/provider/acp/DevinCloudReconnect.test.ts`; manually, kill the ACP child mid-turn and the turn still completes.
- **V8 Sessions browser.** A Devin sessions page lists the account's Cloud sessions with search, refresh and status. Each session suggests the project named after one of its repositories, opens in T3 (importing it) or in Devin. The page is reachable from the sidebar and the command palette, only when a `devinCloud` provider is enabled. Check: `apps/web/src/components/devinSessions/devinSessions.logic.test.ts`; manual walkthrough.
- **V9 Import by id or URL.** The command palette's "Import Devin Cloud session" takes a session id or URL and a project. An id that isn't in the account is rejected, and no thread is created. Importing an already-imported session opens the existing thread. Check: `apps/web/src/components/ImportDevinCloudSession.test.tsx`, `packages/contracts/src/agentSessions.test.ts`.
- **V10 Imported history.** An imported session keeps its Cloud title and full root-agent conversation: user and assistant messages, in order, with original timestamps, clean user text and rewritten references. Subagent and tool traffic are left out. History survives reload, and new turns appear below it. Check: `apps/server/src/provider/acp/DevinCloudHistory.test.ts`; manually, import a real session and reload.
- **V11 No hidden Cloud sessions.** Devin Cloud never starts a remote session for git text generation (commit messages, PR content, branch names, thread titles). It returns an error asking for another provider. Check: `apps/server/src/textGeneration/DevinCloudTextGeneration.ts`.
- **V12 Access control.** Listing Devin sessions requires orchestration read scope. Importing requires operate scope. Check: `apps/server/src/auth/RpcAuthorization.ts`.
