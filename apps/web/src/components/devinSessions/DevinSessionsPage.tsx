import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  matchesDevinSessionQuery,
  type DevinSessionSummary,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import {
  ArrowRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CirclePauseIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloudIcon,
  ExternalLinkIcon,
  FolderIcon,
  FolderGit2Icon,
  LaptopIcon,
  SearchIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useCallback, useContext, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { devinCloudSessionImport, devinSessionList } from "../../state/agentSessions";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useDebouncedValue } from "../../state/queries";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { DevinIcon } from "../Icons";
import { PullRequestListGhost } from "../pullRequest/PullRequestGhosts";
import { PULL_REQUEST_ROW_CLASS, PullRequestRowLines } from "../pullRequest/PullRequestListRow";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { MiddleTruncate } from "../ui/middle-truncate";
import { RefreshIcon } from "../ui/refresh-icon";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Separator } from "../ui/separator";
import { Spinner } from "../ui/spinner";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { suggestDevinSessionProject } from "./devinSessions.logic";
import { focusDevinImport } from "./focusDevinImport";

const DEVIN_DRIVERS = new Set(["devin", "devinCloud", "devinCloudCli"]);

interface ListedSession extends DevinSessionSummary {
  readonly environmentId: EnvironmentId;
  readonly key: string;
}

const STATUS_PRESENTATION: Record<
  string,
  { label: string; Icon: LucideIcon; toneClassName: string }
> = {
  working: {
    label: "Working",
    Icon: CircleDotIcon,
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
  },
  running: {
    label: "Working",
    Icon: CircleDotIcon,
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
  },
  blocked: {
    label: "Waiting for you",
    Icon: CirclePauseIcon,
    toneClassName: "text-amber-600 dark:text-amber-400/90",
  },
  finished: {
    label: "Finished",
    Icon: CircleCheckIcon,
    toneClassName: "text-muted-foreground",
  },
  crashed: { label: "Crashed", Icon: CircleAlertIcon, toneClassName: "text-destructive" },
};

function sessionStatusPresentation(session: Pick<DevinSessionSummary, "kind" | "status">) {
  if (session.status && STATUS_PRESENTATION[session.status]) {
    return STATUS_PRESENTATION[session.status]!;
  }
  return {
    label: session.status ?? (session.kind === "local" ? "Local session" : "Cloud session"),
    Icon: CircleDashedIcon,
    toneClassName: "text-muted-foreground/70",
  };
}

const RECENT_DAYS = 7;
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Recent sessions by default; a search asks the server to match every stored session, keeping
 * the recent list on screen until it answers.
 */
function useDevinSessionLists(
  environmentIds: ReadonlyArray<EnvironmentId>,
  updatedAfter: string,
  query: string,
) {
  const registry = useContext(RegistryContext);
  const listsAtom = useMemo(
    () =>
      Atom.make((get) =>
        environmentIds.map((environmentId) => {
          const recentAtom = devinSessionList({ environmentId, input: { updatedAfter } });
          const atom = query ? devinSessionList({ environmentId, input: { query } }) : recentAtom;
          const result = get(atom);
          const data = Option.getOrNull(AsyncResult.value(result));
          const carried =
            data === null && query ? Option.getOrNull(AsyncResult.value(get(recentAtom))) : null;
          return {
            environmentId,
            data: data ?? carried,
            searching: carried !== null,
            error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
            isPending: result.waiting || result._tag === "Initial",
            refresh: () => registry.refresh(atom),
          };
        }),
      ),
    [environmentIds, updatedAfter, query, registry],
  );
  return useAtomValue(listsAtom);
}

/** Lists the sessions of every Devin provider instance, local and cloud, and opens them in T3. */
export function DevinSessionsPage() {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const [query, setQuery] = useState("");
  const [updatedAfter] = useState(() =>
    new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  );
  const trimmedQuery = query.trim();
  const sentQuery = useDebouncedValue(trimmedQuery, SEARCH_DEBOUNCE_MS);

  const devinEnvironments = useMemo(
    () =>
      environments.filter(
        (environment) =>
          environment.connection.phase === "connected" &&
          environment.serverConfig?.providers.some(
            (provider) => provider.enabled && DEVIN_DRIVERS.has(provider.driver),
          ),
      ),
    [environments],
  );
  const environmentIds = useMemo(
    () => devinEnvironments.map((environment) => environment.environmentId),
    [devinEnvironments],
  );
  const environmentLabels = useMemo(
    () =>
      new Map(
        devinEnvironments.map((environment) => [environment.environmentId, environment.label]),
      ),
    [devinEnvironments],
  );
  const lists = useDevinSessionLists(environmentIds, updatedAfter, sentQuery);
  const searching = trimmedQuery !== sentQuery || lists.some((list) => list.searching);
  const refreshing = !searching && lists.some((list) => list.isPending);
  const showEnvironment = environmentIds.length > 1;

  const sessions = useMemo(
    () =>
      lists.flatMap((list) =>
        (list.data?.sessions ?? []).map((session): ListedSession => ({
          ...session,
          environmentId: list.environmentId,
          key: `${list.environmentId}:${session.providerInstanceId}:${session.sessionId}`,
        })),
      ),
    [lists],
  );
  const groups = useMemo(() => {
    const visible = sessions.filter((session) => matchesDevinSessionQuery(session, trimmedQuery));
    return [
      { kind: "local" as const, label: "Local", Icon: LaptopIcon },
      { kind: "cloud" as const, label: "Cloud", Icon: CloudIcon },
    ]
      .map((group) => ({
        ...group,
        sessions: visible.filter((session) => session.kind === group.kind),
      }))
      .filter((group) => group.sessions.length > 0);
  }, [sessions, trimmedQuery]);
  const shownCount = groups.reduce((count, group) => count + group.sessions.length, 0);
  const loadedOnce = lists.some((list) => list.data !== null);
  const listErrors = lists.flatMap((list) => (list.error ? [list.error] : []));
  const providerFailures = lists.flatMap((list) =>
    (list.data?.failures ?? []).map(
      (failure) => `${failure.providerInstanceId}: ${failure.detail}`,
    ),
  );
  const refresh = useCallback(() => {
    for (const list of lists) list.refresh();
  }, [lists]);
  const projectsByEnvironment = useMemo(() => {
    const byEnvironment = new Map<EnvironmentId, Array<EnvironmentProject>>();
    for (const project of projects) {
      const entries = byEnvironment.get(project.environmentId) ?? [];
      entries.push(project);
      byEnvironment.set(project.environmentId, entries);
    }
    return byEnvironment;
  }, [projects]);

  const listBody =
    environmentIds.length === 0 ? (
      <DevinSessionsEmptyState
        title="No Devin provider enabled"
        description="Enable Devin or Devin Cloud in Settings → Providers to browse its sessions here."
      />
    ) : !loadedOnce && listErrors.length > 0 && !refreshing ? (
      <DevinSessionsEmptyState
        title="Could not load Devin sessions"
        description={listErrors[0]!}
        refreshing={refreshing}
        onRetry={refresh}
      />
    ) : !loadedOnce ? (
      <PullRequestListGhost rows={7} label="Loading Devin sessions" />
    ) : shownCount === 0 ? (
      <DevinSessionsEmptyState
        title={
          trimmedQuery && searching
            ? "Searching all sessions…"
            : trimmedQuery
              ? `Nothing matches “${trimmedQuery.length > 48 ? `${trimmedQuery.slice(0, 48)}…` : trimmedQuery}”`
              : `No Devin sessions in the last ${RECENT_DAYS} days`
        }
        description={
          trimmedQuery
            ? "Search by title, repository, directory or session ID."
            : "Search to find older sessions, or start one with Devin locally or in the cloud."
        }
        refreshing={refreshing || searching}
        onRetry={refresh}
        {...(trimmedQuery ? { onClearQuery: () => setQuery("") } : {})}
      />
    ) : (
      <div className="space-y-3">
        {groups.map((group) => (
          <Collapsible key={group.kind} defaultOpen>
            <h2>
              <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 pb-1 text-left text-xs font-medium text-muted-foreground/70 hover:text-foreground">
                <ChevronRightIcon
                  aria-hidden
                  className="size-3.5 shrink-0 transition-transform group-data-panel-open:rotate-90"
                />
                <group.Icon aria-hidden className="size-3.5 shrink-0" />
                <span className="shrink-0">{group.label}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground/50">
                  {group.sessions.length}
                </span>
                <Separator className="min-w-2 flex-1" />
              </CollapsibleTrigger>
            </h2>
            <CollapsiblePanel keepMounted>
              <div className="space-y-0.5 pt-0.5">
                {group.sessions.map((session) => (
                  <DevinSessionRow
                    key={session.key}
                    session={session}
                    projects={projectsByEnvironment.get(session.environmentId) ?? NO_PROJECTS}
                    environmentLabel={
                      showEnvironment ? environmentLabels.get(session.environmentId) : undefined
                    }
                  />
                ))}
              </div>
            </CollapsiblePanel>
          </Collapsible>
        ))}
        <div className="flex justify-center py-3 text-xs text-muted-foreground">
          {searching ? (
            <span className="flex items-center gap-2">
              <Spinner aria-hidden size="sm" />
              Searching all sessions
            </span>
          ) : trimmedQuery ? null : (
            <span>
              Showing activity from the last {RECENT_DAYS} days. Search to find older sessions.
            </span>
          )}
        </div>
      </div>
    );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          <WorkspacePageHeader
            electron={isElectron}
            reserveNativeControls={isElectron}
            className="relative bg-background"
          >
            <WorkspaceBreadcrumb ariaLabel="Devin sessions breadcrumb">
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">Devin Sessions</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <div className="min-w-0 flex-1" />
          </WorkspacePageHeader>

          <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
            <WorkspacePageContainer width="expanded" className="min-h-full gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <InputGroup className="min-w-0 flex-1 **:[input]:h-9 sm:**:[input]:h-8">
                  <InputGroupAddon>
                    <SearchIcon aria-hidden />
                  </InputGroupAddon>
                  <InputGroupInput
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    placeholder="Search Devin sessions"
                    aria-label="Search Devin sessions"
                  />
                </InputGroup>
                <Button
                  size="icon"
                  variant="outline"
                  aria-label="Refresh Devin sessions"
                  onClick={refresh}
                  disabled={refreshing || environmentIds.length === 0}
                >
                  <RefreshIcon size="md" refreshing={refreshing} />
                </Button>
              </div>

              {listBody}

              {loadedOnce && (listErrors.length > 0 || providerFailures.length > 0) ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning-surface px-3 py-2 text-xs">
                  <span className="min-w-0 break-words">
                    {[...listErrors, ...providerFailures].join(" ")}
                  </span>
                  <Button size="xs" variant="outline" disabled={refreshing} onClick={refresh}>
                    Retry
                  </Button>
                </div>
              ) : null}
            </WorkspacePageContainer>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

const NO_PROJECTS: ReadonlyArray<EnvironmentProject> = [];

/**
 * The whole row opens the session in T3, into the project it most likely belongs to, or asks for
 * one when nothing matches. A session already in T3 just focuses its thread.
 */
const DevinSessionRow = memo(function DevinSessionRow({
  session,
  projects,
  environmentLabel,
}: {
  session: ListedSession;
  projects: ReadonlyArray<EnvironmentProject>;
  environmentLabel: string | undefined;
}) {
  const navigate = useNavigate();
  const openSession = useAtomCommand(devinCloudSessionImport, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const suggested = useMemo(
    () => suggestDevinSessionProject(session, projects),
    [session, projects],
  );
  const status = sessionStatusPresentation(session);
  const repository = session.repositories[0];
  const sessionUrl = session.url;
  const canOpen = projects.length > 0 && !pending;

  const open = async (projectId: ProjectId) => {
    if (pending) return;
    setPending(true);
    try {
      const result = await openSession({
        environmentId: session.environmentId,
        input: {
          projectId,
          providerInstanceId: session.providerInstanceId,
          session: session.sessionId,
        },
      });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        throw failure instanceof Error ? failure : new Error("Could not open the session.");
      }
      await focusDevinImport(navigate, session.environmentId, result.value);
    } catch (failure) {
      toastManager.add({
        type: "error",
        title: "Could not open the Devin session",
        description: failure instanceof Error ? failure.message : "An error occurred.",
      });
    } finally {
      setPending(false);
    }
  };
  const openSuggested = () => {
    if (!canOpen) return;
    if (suggested) void open(suggested.id);
    else setProjectMenuOpen(true);
  };

  const openButton = (
    <Button
      size="micro"
      variant="outline"
      disabled={!canOpen}
      onClick={suggested ? openSuggested : undefined}
      className="relative"
    >
      {pending ? <Spinner aria-hidden size="sm" /> : null}
      {pending ? "Opening…" : "Open in T3"}
      {pending ? null : suggested ? (
        <ArrowRightIcon aria-hidden />
      ) : (
        <ChevronDownIcon aria-hidden />
      )}
    </Button>
  );

  return (
    <div
      className={cn(
        PULL_REQUEST_ROW_CLASS,
        "relative px-3 py-2.5 transition-colors hover:bg-accent/60 has-[:focus-visible]:bg-accent/60 has-[[data-popup-open]]:bg-accent/60",
        "[content-visibility:auto] [contain-intrinsic-block-size:36.5px]",
      )}
    >
      <button
        type="button"
        disabled={!canOpen}
        onClick={openSuggested}
        aria-label={`Open ${session.title ?? session.sessionId} in T3`}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left focus-visible:outline-none disabled:cursor-default"
      >
        <Tooltip>
          <TooltipTrigger
            render={<span className="mt-0.75 flex w-4 shrink-0 self-start justify-center" />}
          >
            <status.Icon aria-label={status.label} className={cn("size-4", status.toneClassName)} />
          </TooltipTrigger>
          <TooltipPopup side="top">{status.label}</TooltipPopup>
        </Tooltip>
        <PullRequestRowLines
          number={null}
          title={session.title ?? session.sessionId}
          meta={
            <>
              {repository ? (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <FolderGit2Icon aria-hidden className="size-3 shrink-0" />
                  <span className="truncate">
                    {repository}
                    {session.repositories.length > 1 ? ` +${session.repositories.length - 1}` : ""}
                  </span>
                </span>
              ) : session.cwd ? (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <FolderIcon aria-hidden className="size-3 shrink-0" />
                  <span className="flex min-w-0 font-mono">
                    <MiddleTruncate value={session.cwd} />
                  </span>
                </span>
              ) : null}
              <span className="shrink-0 font-mono text-muted-foreground/70">
                {session.sessionId}
              </span>
              {environmentLabel ? (
                <span className="min-w-0 max-w-32 truncate">{environmentLabel}</span>
              ) : null}
            </>
          }
          updatedAt={session.updatedAt}
        />
      </button>
      {/* Out of the row's flow like the thread PR panel's actions: it covers the time on hover,
          on the row's own hover color, so no row reserves a column for it. */}
      <span
        className={cn(
          "absolute right-2 bottom-2 flex items-center gap-1 pl-5",
          pending
            ? "opacity-100"
            : "pointer-events-none opacity-0 group-hover/pr-row:pointer-events-auto group-hover/pr-row:opacity-100",
          "has-[[data-popup-open]]:pointer-events-auto has-[[data-popup-open]]:opacity-100",
          "group-has-[:focus-visible]/pr-row:pointer-events-auto group-has-[:focus-visible]/pr-row:opacity-100",
        )}
      >
        {/* Masked on its own layer so the fade never clips the buttons' focus rings. */}
        <span
          aria-hidden
          className="absolute inset-0 rounded-md bg-background [mask-image:linear-gradient(to_right,transparent,black_1rem)]"
        >
          <span className="absolute inset-0 bg-accent/60" />
        </span>
        {sessionUrl ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost"
                  aria-label="Open in Devin"
                  className="relative"
                  onClick={() => void readLocalApi()?.shell.openExternal(sessionUrl)}
                >
                  <ExternalLinkIcon />
                </Button>
              }
            />
            <TooltipPopup side="top">Open in Devin</TooltipPopup>
          </Tooltip>
        ) : null}
        {suggested || projects.length === 0 ? (
          openButton
        ) : (
          <Menu open={projectMenuOpen} onOpenChange={setProjectMenuOpen}>
            <MenuTrigger disabled={!canOpen} render={openButton} />
            <MenuPopup align="end" side="bottom">
              <MenuGroup>
                <MenuGroupLabel>Open in project</MenuGroupLabel>
                {projects.map((project) => (
                  <MenuItem key={project.id} onClick={() => void open(project.id)}>
                    <FolderIcon />
                    {project.title}
                  </MenuItem>
                ))}
              </MenuGroup>
            </MenuPopup>
          </Menu>
        )}
      </span>
    </div>
  );
});

function DevinSessionsEmptyState({
  title,
  description,
  refreshing = false,
  onRetry,
  onClearQuery,
}: {
  title: string;
  description: string;
  refreshing?: boolean;
  onRetry?: () => void;
  onClearQuery?: () => void;
}) {
  return (
    <Empty>
      <EmptyMedia variant="icon">
        <DevinIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {onRetry || onClearQuery ? (
        <div className="flex flex-wrap justify-center gap-2">
          {onClearQuery ? (
            <Button size="sm" variant="outline" onClick={onClearQuery}>
              <SearchIcon className="size-3.5" />
              Clear search
            </Button>
          ) : null}
          {onRetry ? (
            <Button size="sm" variant="outline" disabled={refreshing} onClick={onRetry}>
              <RefreshIcon size="sm" refreshing={refreshing} />
              {refreshing ? "Checking..." : "Check again"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Empty>
  );
}
