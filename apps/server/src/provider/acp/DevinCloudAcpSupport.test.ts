import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as AcpCompat from "effect-acp/compat";

import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import {
  listDevinCloudSessions,
  buildDevinCloudAcpSpawnInput,
  devinCloudCatalogFromConfigOptions,
  devinNativeSessionFromAcp,
  resolveDevinCloudOrganizationId,
  withDevinCloudOrganizationLock,
} from "./DevinCloudAcpSupport.ts";
import { makeDevinCloudReferenceRewriter } from "./DevinReferences.ts";

const configOptions: ReadonlyArray<AcpCompat.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "devin-2-5",
    options: [
      { value: "devin-2-5", name: "Normal" },
      { value: "devin-ultra", name: "Ultra" },
    ],
  },
  {
    id: "org_id",
    name: "Organization",
    type: "select",
    currentValue: "org-a",
    options: [
      { value: "org-a", name: "Personal" },
      { value: "org-b", name: "Work" },
    ],
  },
];

describe("resolveDevinCloudOrganizationId", () => {
  it("prefers the thread-level org_id selection over the settings default", () => {
    expect(resolveDevinCloudOrganizationId([{ id: "org_id", value: "org-b" }], "org-a")).toBe(
      "org-b",
    );
  });

  it("falls back to the settings default for missing or blank selections", () => {
    expect(resolveDevinCloudOrganizationId([{ id: "org_id", value: "  " }], "org-a")).toBe("org-a");
    expect(resolveDevinCloudOrganizationId(undefined, "org-a")).toBe("org-a");
    expect(resolveDevinCloudOrganizationId(null, undefined)).toBeUndefined();
  });
});

describe("buildDevinCloudAcpSpawnInput", () => {
  it("runs cloud ACP through the configured CLI and environment", () => {
    expect(
      buildDevinCloudAcpSpawnInput({ binaryPath: "/bin/devin" }, "/workspace", {
        XDG_DATA_HOME: "/isolated",
      }),
    ).toEqual({
      command: "/bin/devin",
      args: ["acp", "--cloud"],
      cwd: "/workspace",
      env: { XDG_DATA_HOME: "/isolated" },
    });
    expect(buildDevinCloudAcpSpawnInput({ binaryPath: "" }, "/workspace").command).toBe("devin");
  });
});

describe("devinCloudCatalogFromConfigOptions", () => {
  it("reads advertised models and organizations", () => {
    expect(devinCloudCatalogFromConfigOptions(configOptions)).toEqual({
      models: [
        { slug: "devin-2-5", name: "Normal" },
        { slug: "devin-ultra", name: "Ultra" },
      ],
      currentModel: "devin-2-5",
      organizations: [
        { id: "org-a", name: "Personal" },
        { id: "org-b", name: "Work" },
      ],
      defaultOrganizationId: "org-a",
    });
    expect(devinCloudCatalogFromConfigOptions([])).toEqual({});
  });
});

describe("devinNativeSessionFromAcp", () => {
  it("maps Devin session metadata and hides archived sessions", () => {
    expect(
      devinNativeSessionFromAcp({
        sessionId: " session-1 ",
        cwd: "/home/ubuntu",
        title: " Fix login ",
        updatedAt: "2026-10-01T00:00:00.000Z",
        _meta: {
          "cognition.ai/url": "https://app.devin.ai/sessions/session-1",
          "cognition.ai/statusEnum": "finished",
          "cognition.ai/sessionRepos": [{ name: "marcosfede/t3code" }, { other: 1 }],
          "cognition.ai/messageExcerpts": "Done",
        },
      }),
    ).toEqual({
      sessionId: "session-1",
      title: "Fix login",
      cwd: "/home/ubuntu",
      updatedAt: "2026-10-01T00:00:00.000Z",
      url: "https://app.devin.ai/sessions/session-1",
      status: "finished",
      repositories: ["marcosfede/t3code"],
      excerpt: "Done",
    });
    expect(
      devinNativeSessionFromAcp({
        sessionId: "archived",
        cwd: "/",
        _meta: { "cognition.ai/isArchived": true },
      }),
    ).toBeUndefined();
  });
});

const makeFakeRuntime = () => {
  const setCalls: Array<[string, unknown]> = [];
  const runtime = {
    start: () =>
      Effect.succeed({ sessionId: "session", sessionSetupResult: { sessionId: "session" } }),
    getConfigOptions: Effect.succeed(configOptions),
    setConfigOption: (configId: string, value: unknown) =>
      Effect.sync(() => {
        setCalls.push([configId, value]);
        return { configOptions: [...configOptions] };
      }),
    prompt: () => Effect.succeed({ stopReason: "end_turn" }),
    loadSession: () => Effect.succeed({}),
    resumeSession: () => Effect.succeed({}),
  } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];
  return { runtime, setCalls };
};

describe("withDevinCloudOrganizationLock", () => {
  it.effect("selects the organization on a new session and locks it after the first prompt", () =>
    Effect.gen(function* () {
      const fake = makeFakeRuntime();
      const runtime = yield* withDevinCloudOrganizationLock(fake.runtime, {
        organizationId: "org-b",
      });
      yield* runtime.start();
      expect(fake.setCalls).toEqual([["org_id", "org-b"]]);
      yield* runtime.prompt({ prompt: [] } as never);
      yield* runtime.setConfigOption("org_id", "org-a");
      yield* runtime.setConfigOption("model", "devin-ultra");
      expect(fake.setCalls).toEqual([
        ["org_id", "org-b"],
        ["model", "devin-ultra"],
      ]);
    }),
  );

  it.effect("never changes the organization of a resumed session", () =>
    Effect.gen(function* () {
      const fake = makeFakeRuntime();
      const runtime = yield* withDevinCloudOrganizationLock(fake.runtime, {
        resumeSessionId: "existing",
        organizationId: "org-b",
      });
      yield* runtime.start();
      yield* runtime.setConfigOption("org_id", "org-b");
      expect(fake.setCalls).toEqual([]);
    }),
  );
});

describe("makeDevinCloudReferenceRewriter", () => {
  const chunk = (
    text: string,
    sessionMeta?: Record<string, string>,
  ): AcpCompat.SessionNotification => {
    const notification: AcpCompat.SessionNotification = {
      sessionId: "session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    };
    return sessionMeta
      ? { ...notification, _meta: { "cognition.ai/session": sessionMeta } }
      : notification;
  };
  const textOf = (notification: AcpCompat.SessionNotification) =>
    notification.update.sessionUpdate === "agent_message_chunk" &&
    notification.update.content.type === "text"
      ? notification.update.content.text
      : undefined;

  it("renders citations as labels until the session URL is known", () => {
    const rewrite = makeDevinCloudReferenceRewriter();
    expect(
      textOf(
        rewrite(
          chunk(
            "<ref_file file=\"/workspace/README.md\"/> and <ref_snippet lines='12' file='/workspace/src/main.ts' />",
          ),
        ),
      ),
    ).toBe("README.md and main.ts:12");
  });

  it("links citations to the cloud session and joins fragmented tags", () => {
    const rewrite = makeDevinCloudReferenceRewriter();
    const url = { "cognition.ai/url": "https://app.devin.ai/sessions/abc?secret=1" };
    expect(textOf(rewrite(chunk("See <ref_fi", url)))).toBe("See ");
    expect(textOf(rewrite(chunk('le file="/a.ts"/>.')))).toBe(
      '[a.ts](https://app.devin.ai/sessions/abc "Open citation in Devin").',
    );
  });

  it("leaves citations inside code untouched", () => {
    const rewrite = makeDevinCloudReferenceRewriter();
    const text = '`<ref_file file="/a.ts"/>`';
    expect(textOf(rewrite(chunk(text)))).toBe(text);
  });
});

describe("listDevinCloudSessions", () => {
  const info = (sessionId: string, orgId: string) => ({
    sessionId,
    cwd: "/repo",
    title: sessionId,
    updatedAt: "2020-01-01T00:00:00Z",
    _meta: { "cognition.ai/orgId": orgId },
  });
  it.effect(
    "returns one page across organizations, including older sessions, without draining the cursor",
    () =>
      Effect.gen(function* () {
        const requests: unknown[] = [];
        const page = yield* listDevinCloudSessions({
          initialize: () => Effect.succeed({ protocolVersion: 1 }),
          request: (method, params) => {
            requests.push({ method, params });
            return Effect.succeed({
              sessions: [info("one", "a"), info("two", "b")],
              nextCursor: "next",
            });
          },
        });
        expect(page.sessions.map((session) => session.sessionId)).toEqual(["one", "two"]);
        expect(page.nextCursor).toBe("next");
        expect(requests).toEqual([
          { method: "session/list", params: { _meta: { "cognition.ai/limit": 50 } } },
        ]);
      }),
  );
  it.effect("forwards pagination and search to Devin", () =>
    Effect.gen(function* () {
      const requests: unknown[] = [];
      const page = yield* listDevinCloudSessions(
        {
          initialize: () => Effect.succeed({ protocolVersion: 1 }),
          request: (method, params) => {
            requests.push({ method, params });
            return Effect.succeed({ sessions: [] });
          },
        },
        { cursor: "page-two", query: "fix billing" },
      );
      expect(page.nextCursor).toBeNull();
      expect(requests).toEqual([
        {
          method: "session/list",
          params: {
            cursor: "page-two",
            _meta: { "cognition.ai/limit": 50, "cognition.ai/content": "fix billing" },
          },
        },
      ]);
    }),
  );
  it.effect("looks up an import directly instead of scanning account history", () =>
    Effect.gen(function* () {
      const requests: unknown[] = [];
      yield* listDevinCloudSessions(
        {
          initialize: () => Effect.succeed({ protocolVersion: 1 }),
          request: (method, params) => {
            requests.push({ method, params });
            return Effect.succeed({ sessions: [info("old-session", "b")] });
          },
        },
        { sessionId: "old-session" },
      );
      expect(requests).toEqual([
        {
          method: "session/list",
          params: {
            _meta: {
              "cognition.ai/limit": 50,
              "cognition.ai/sessionIds": ["old-session"],
              "cognition.ai/skipDiscovery": true,
            },
          },
        },
      ]);
    }),
  );
});
