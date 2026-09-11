import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { parseDevinCloudSessionId, type ProviderInstanceId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, CloudIcon, FolderIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { devinCloudSessionImport } from "../state/agentSessions";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerKeybindingsAtom, primaryServerProvidersAtom } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import type { Project } from "../types";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "./CommandPalette.logic";

export function ImportDevinCloudSession(props: {
  readonly projects: ReadonlyArray<Project>;
  readonly initialProject: Project | undefined;
  readonly onBack: () => void;
  readonly onClose: () => void;
}) {
  const [project, setProject] = useState(
    props.initialProject ?? (props.projects.length === 1 ? props.projects[0] : undefined),
  );
  const [providerId, setProviderId] = useState<ProviderInstanceId>();
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryProviders = useAtomValue(primaryServerProvidersAtom);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const environment = environments.find((entry) => entry.environmentId === project?.environmentId);
  const providers = (
    environment?.serverConfig?.providers ??
    (project?.environmentId === primaryEnvironmentId ? primaryProviders : [])
  ).filter(
    (provider) =>
      (provider.driver === "devinCloud" || provider.driver === "devinCloudCli") && provider.enabled,
  );
  const provider =
    providers.find((entry) => entry.instanceId === providerId) ??
    (providers.length === 1 ? providers[0] : undefined);
  const importSession = useAtomCommand(devinCloudSessionImport, { reportFailure: false });
  const navigate = useNavigate();

  const submit = async () => {
    if (!project || !provider || inFlight.current) return;
    if (!parseDevinCloudSessionId(query)) {
      setError("Paste a Devin session URL or session ID.");
      return;
    }
    if (environment?.connection.phase !== "connected") {
      setError("Connect to this project's environment before importing.");
      return;
    }
    inFlight.current = true;
    setPending(true);
    setError(undefined);
    try {
      const result = await importSession({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          providerInstanceId: provider.instanceId,
          session: query.trim(),
        },
      });
      if (!mounted.current) return;
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not import the session.");
        return;
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(
          scopeThreadRef(project.environmentId, result.value.threadId),
        ),
      });
      props.onClose();
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error ? failure.message : "Could not open the imported thread.",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  };

  const choices: CommandPaletteActionItem[] = !project
    ? props.projects.map((entry) => ({
        kind: "action",
        value: `${entry.environmentId}:${entry.id}`,
        searchTerms: [entry.title, entry.workspaceRoot],
        title: entry.title,
        description: `${environments.find((env) => env.environmentId === entry.environmentId)?.label ?? ""} · ${entry.workspaceRoot}`,
        icon: <FolderIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          setProject(entry);
          setQuery("");
          setError(undefined);
        },
      }))
    : !provider
      ? providers.map((entry) => ({
          kind: "action",
          value: entry.instanceId,
          searchTerms: [entry.displayName ?? "Devin Cloud", entry.instanceId],
          title: entry.displayName ?? "Devin Cloud",
          description: entry.instanceId,
          icon: <CloudIcon className={ITEM_ICON_CLASS} />,
          run: async () => {
            setProviderId(entry.instanceId);
            setQuery("");
            setError(undefined);
          },
        }))
      : [];
  const filteredChoices = choices.filter((entry) =>
    entry.searchTerms.some((term) => term.toLowerCase().includes(query.toLowerCase())),
  );
  const ready = project !== undefined && provider !== undefined;

  return (
    <CommandPaletteContent
      key={ready ? "link" : project ? "provider" : "project"}
      aria-label="Import Devin Cloud session"
      value={query}
      onValueChange={(value) => {
        if (!pending) {
          setQuery(value);
          setError(undefined);
        }
      }}
      mode="none"
      autoHighlight={ready ? false : "always"}
      footerActionLabel={pending ? "Importing…" : ready ? "Import" : "Select"}
      inputProps={{
        placeholder: !project
          ? "Choose a project"
          : !provider
            ? "Choose a Devin Cloud provider"
            : "Paste Devin session URL or ID",
        disabled: pending,
        wrapperClassName: "[&_[data-slot=autocomplete-start-addon]]:pointer-events-auto",
        startAddon: (
          <button
            type="button"
            aria-label="Back"
            className="flex cursor-pointer items-center"
            disabled={pending}
            onClick={props.onBack}
          >
            <ArrowLeftIcon />
          </button>
        ),
        onKeyDown: (event) => {
          if (ready && event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        },
      }}
    >
      {error ? (
        <div role="alert" className="px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {ready ? (
        <div className="px-4 py-5 text-sm text-muted-foreground" aria-live="polite">
          {pending
            ? "Loading conversation…"
            : `Import into ${project.title} and continue the same cloud session.`}
        </div>
      ) : (
        <CommandPaletteResults
          groups={
            filteredChoices.length
              ? [
                  {
                    value: "import-target",
                    label: project ? "Providers" : "Projects",
                    items: filteredChoices,
                  },
                ]
              : []
          }
          isActionsOnly={false}
          keybindings={keybindings}
          onExecuteItem={(item) => {
            if (item.kind === "action") void item.run();
          }}
          emptyStateMessage={
            project && providers.length === 0
              ? "Enable Devin Cloud in Settings → Providers first."
              : props.projects.length === 0
                ? "Add a project before importing a session."
                : "No matches."
          }
        />
      )}
    </CommandPaletteContent>
  );
}
