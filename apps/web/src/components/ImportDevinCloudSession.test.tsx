import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CommandPaletteContent } from "./CommandPaletteContent";
import type { CommandPaletteResults } from "./CommandPaletteResults";
import type { Project } from "../types";

const state = vi.hoisted(() => ({
  importSession: vi.fn(),
  navigate: vi.fn(),
  close: vi.fn(),
  providers: [] as ServerProvider[],
  connected: true,
  providersAtom: Symbol("providers"),
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.importSession }));
vi.mock("../state/agentSessions", () => ({ devinCloudSessionImport: {} }));
vi.mock("../state/server", () => ({
  primaryServerProvidersAtom: state.providersAtom,
  primaryServerKeybindingsAtom: Symbol("keybindings"),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === state.providersAtom ? [] : {}),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironmentId: () => "local",
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "remote",
        label: "Remote",
        connection: { phase: state.connected ? "connected" : "disconnected" },
        serverConfig: { providers: state.providers },
      },
    ],
  }),
}));
vi.mock("./CommandPaletteContent", () => ({
  CommandPaletteContent: (
    props: Omit<ComponentProps<typeof CommandPaletteContent>, "onValueChange"> & {
      onValueChange: (value: string) => void;
    },
  ) => (
    <div>
      <input
        placeholder={props.inputProps.placeholder}
        disabled={props.inputProps.disabled}
        value={props.value as string}
        onChange={(event) => props.onValueChange?.(event.target.value)}
        onKeyDown={props.inputProps.onKeyDown}
      />
      {props.children}
    </div>
  ),
}));
vi.mock("./CommandPaletteResults", () => ({
  CommandPaletteResults: (props: ComponentProps<typeof CommandPaletteResults>) => (
    <div>
      {props.groups.flatMap((group) =>
        group.items.map((item) => (
          <button key={item.value} onClick={() => props.onExecuteItem(item)}>
            {item.title}
          </button>
        )),
      )}
    </div>
  ),
}));

import { ImportDevinCloudSession } from "./ImportDevinCloudSession";

const project: Project = {
  id: ProjectId.make("project"),
  environmentId: EnvironmentId.make("remote"),
  title: "Project",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-11T10:00:00.000Z",
  updatedAt: "2026-09-11T10:00:00.000Z",
};
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("remote-cloud"),
  driver: ProviderDriverKind.make("devinCloud"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-11T10:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
let renderer: ReactTestRenderer;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.providers = [provider];
  state.connected = true;
  state.importSession.mockResolvedValue({
    _tag: "Success",
    value: { threadId: ThreadId.make("imported-thread") },
  });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});
const mount = async () => {
  await act(async () => {
    renderer = create(
      <ImportDevinCloudSession
        projects={[project]}
        initialProject={project}
        onBack={() => {}}
        onClose={state.close}
      />,
    );
  });
};
const type = async (text: string) => {
  await act(async () =>
    renderer.root.findByType("input").props.onChange({ target: { value: text } }),
  );
};
const enter = () =>
  renderer.root.findByType("input").props.onKeyDown({
    key: "Enter",
    nativeEvent: { isComposing: false },
    preventDefault: vi.fn(),
  });

describe("ImportDevinCloudSession", () => {
  it.each(["devinCloud", "devinCloudCli"] as const)(
    "validates links and imports through the selected cloud driver (%s)",
    async (driver) => {
      state.providers = [{ ...provider, driver: ProviderDriverKind.make(driver) }];
      await mount();
      await type("https://example.com/sessions/wrong");
      await act(async () => enter());
      expect(state.importSession).not.toHaveBeenCalled();
      expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain(
        "Paste a Devin",
      );
      await type("https://app.devin.ai/sessions/session-1");
      await act(async () => enter());
      expect(state.importSession).toHaveBeenCalledWith({
        environmentId: "remote",
        input: {
          projectId: "project",
          providerInstanceId: "remote-cloud",
          session: "https://app.devin.ai/sessions/session-1",
        },
      });
      expect(state.navigate).toHaveBeenCalledWith({
        to: "/$environmentId/$threadId",
        params: { environmentId: "remote", threadId: "imported-thread" },
      });
      expect(state.close).toHaveBeenCalledOnce();
    },
  );

  it("prevents repeated Enter from importing twice while loading", async () => {
    let finish!: (result: unknown) => void;
    state.importSession.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await mount();
    await type("session-1");
    await act(async () => {
      enter();
      enter();
    });
    expect(state.importSession).toHaveBeenCalledOnce();
    expect(state.navigate).not.toHaveBeenCalled();
    await act(async () =>
      finish({ _tag: "Success", value: { threadId: ThreadId.make("imported-thread") } }),
    );
    expect(state.close).toHaveBeenCalledOnce();
  });

  it("asks for an ambiguous cloud provider and blocks import while disconnected", async () => {
    state.providers = [
      provider,
      {
        ...provider,
        instanceId: ProviderInstanceId.make("other-cloud"),
        displayName: "Other cloud",
      },
    ];
    state.connected = false;
    await mount();
    await act(async () => renderer.root.findAllByType("button")[1]!.props.onClick());
    await type("session-1");
    await act(async () => enter());
    expect(state.importSession).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("Connect");
  });
});
