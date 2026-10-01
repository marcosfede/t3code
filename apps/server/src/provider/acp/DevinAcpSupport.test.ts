import { describe, expect, it } from "@effect/vitest";
import { DEVIN_CLOUD_DEFAULT_MODEL } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyDevinAcpModelSelection,
  buildDevinAcpSpawnInput,
  currentDevinModelIdFromSessionSetup,
  supportedDevinModelIdsFromSessionSetup,
} from "./DevinAcpSupport.ts";

describe("buildDevinAcpSpawnInput", () => {
  it("launches `devin acp` with the configured binary path", () => {
    const spawn = buildDevinAcpSpawnInput({ binaryPath: "/usr/local/bin/devin" }, "/tmp/project", {
      HOME: "/home/dev",
    });

    expect(spawn).toEqual({
      command: "/usr/local/bin/devin",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { HOME: "/home/dev" },
      forceKillAfter: "1 second",
    });
  });

  it("falls back to `devin` on PATH and omits env when not provided", () => {
    const spawn = buildDevinAcpSpawnInput(null, "/tmp/project");

    expect(spawn).toEqual({
      command: "devin",
      args: ["acp"],
      cwd: "/tmp/project",
      forceKillAfter: "1 second",
    });
  });
});

describe("currentDevinModelIdFromSessionSetup", () => {
  it("prefers the unstable models state when present", () => {
    const setup = {
      sessionId: "sess-1",
      models: {
        availableModels: [],
        currentModelId: " swe-1-6-fast ",
      },
    } as unknown as EffectAcpSchema.NewSessionResponse;
    expect(currentDevinModelIdFromSessionSetup(setup)).toBe("swe-1-6-fast");
  });

  it("falls back to the negotiated model config option", () => {
    const setup = {
      sessionId: "sess-1",
      configOptions: [
        {
          type: "select",
          id: "model",
          name: "Model",
          category: "model",
          currentValue: "swe-1-6-fast",
          options: [{ name: "SWE-1.6 Fast", value: "swe-1-6-fast" }],
        },
      ],
    } as unknown as EffectAcpSchema.NewSessionResponse;
    expect(currentDevinModelIdFromSessionSetup(setup)).toBe("swe-1-6-fast");
  });

  it("returns undefined when neither surface reports a model", () => {
    const setup = {
      sessionId: "sess-1",
      configOptions: [],
    } as unknown as EffectAcpSchema.NewSessionResponse;
    expect(currentDevinModelIdFromSessionSetup(setup)).toBeUndefined();
  });
});

describe("supportedDevinModelIdsFromSessionSetup", () => {
  it("collects flat and grouped model option values", () => {
    const setup = {
      sessionId: "sess-1",
      configOptions: [
        {
          type: "select",
          id: "model",
          name: "Model",
          category: "model",
          currentValue: "swe-1-6-slow",
          options: [
            { name: "SWE-1.6 Slow", value: " swe-1-6-slow " },
            { group: "Other", options: [{ name: "SWE-1.6 Fast", value: "swe-1-6-fast" }] },
          ],
        },
      ],
    } as unknown as EffectAcpSchema.NewSessionResponse;
    expect(supportedDevinModelIdsFromSessionSetup(setup)).toEqual(
      new Set(["swe-1-6-slow", "swe-1-6-fast"]),
    );
  });

  it("returns undefined when the session exposes no model option", () => {
    const setup = {
      sessionId: "sess-1",
      configOptions: [],
    } as unknown as EffectAcpSchema.NewSessionResponse;
    expect(supportedDevinModelIdsFromSessionSetup(setup)).toBeUndefined();
  });
});

const traitConfigOptions = (input: { readonly thoughtLevel: string; readonly speed?: string }) =>
  [
    {
      type: "select",
      id: "thought_level",
      name: "Thinking",
      category: "thought_level",
      currentValue: input.thoughtLevel,
      options: ["low", "medium", "high", "max"].map((value) => ({ value, name: value })),
    },
    ...(input.speed
      ? [
          {
            type: "select",
            id: "speed",
            name: "Speed",
            category: "model_config",
            currentValue: input.speed,
            options: [
              { value: "standard", name: "Standard" },
              { value: "fast", name: "Fast" },
            ],
          },
        ]
      : []),
  ] as unknown as ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

describe("applyDevinAcpModelSelection", () => {
  const makeRecordingRuntime = (
    failure?: EffectAcpErrors.AcpError,
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [],
  ) => {
    const modelCalls: Array<string> = [];
    const configOptionCalls: Array<readonly [string, string | boolean]> = [];
    const record = (): Effect.Effect<void, EffectAcpErrors.AcpError> =>
      failure ? Effect.fail(failure) : Effect.void;
    const runtime = {
      getConfigOptions: Effect.sync(() => configOptions),
      setModel: (model: string) =>
        Effect.suspend(() => {
          modelCalls.push(model);
          return record();
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.suspend(() => {
          configOptionCalls.push([configId, value] as const);
          return record().pipe(
            Effect.as({
              configOptions: [],
            } satisfies EffectAcpSchema.SetSessionConfigOptionResponse),
          );
        }),
    };
    return { runtime, modelCalls, configOptionCalls };
  };

  it.effect("sets the model config option when the requested model differs", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "swe-1-6-fast",
        requestedModelId: "swe-1-6",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["swe-1-6"]);
      expect(result).toBe("swe-1-6");
    }),
  );

  it.effect("skips set_config_option when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "swe-1-6-fast",
        requestedModelId: "swe-1-6-fast",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("swe-1-6-fast");
    }),
  );

  it.effect("skips set_config_option when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "swe-1-6-fast",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("swe-1-6-fast");
    }),
  );

  it.effect("keeps the current model when the requested one is not session-accepted", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "swe-1-6-slow",
        requestedModelId: "swe-1-6-fast",
        supportedModelIds: new Set(["swe-1-6-slow"]),
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("swe-1-6-slow");
    }),
  );

  it.effect("switches when the requested model is session-accepted", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "swe-1-6-slow",
        requestedModelId: "swe-1-6-fast",
        supportedModelIds: new Set(["swe-1-6-slow", "swe-1-6-fast"]),
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["swe-1-6-fast"]);
      expect(result).toBe("swe-1-6-fast");
    }),
  );

  it.effect("selects standard Cloud modes through the negotiated version option", () =>
    Effect.gen(function* () {
      for (const requestedModelId of [
        "devin-2-5",
        "devin-fast-opus",
        "devin-ultra",
        "devin_lite",
        "devin-auto",
      ]) {
        const { runtime, modelCalls, configOptionCalls } = makeRecordingRuntime();
        const result = yield* applyDevinAcpModelSelection({
          runtime,
          currentModelId: requestedModelId === "devin-2-5" ? "devin-ultra" : "devin-2-5",
          requestedModelId,
          modelConfigOptionId: "devin_version",
          mapError: (cause) => cause.message,
        });
        expect(result).toBe(requestedModelId);
        expect(modelCalls).toEqual([]);
        expect(configOptionCalls).toEqual([["devin_version", requestedModelId]]);
      }
    }),
  );

  it.effect("keeps the negotiated model when the Cloud default placeholder is selected", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, configOptionCalls } = makeRecordingRuntime();
      for (const currentModelId of [undefined, "session-model"]) {
        const result = yield* applyDevinAcpModelSelection({
          runtime,
          currentModelId,
          requestedModelId: DEVIN_CLOUD_DEFAULT_MODEL,
          modelConfigOptionId: "devin_version",
          mapError: (cause) => cause.message,
        });
        expect(result).toBe(currentModelId);
      }
      expect(modelCalls).toEqual([]);
      expect(configOptionCalls).toEqual([]);
    }),
  );

  it.effect("applies reasoning and fast mode through the model's config options", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, configOptionCalls } = makeRecordingRuntime(
        undefined,
        traitConfigOptions({ thoughtLevel: "medium", speed: "standard" }),
      );
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "gpt-6-sol-medium",
        requestedModelId: "claude-opus-5-5-medium",
        options: [
          { id: "reasoning", value: "high" },
          { id: "fastMode", value: true },
        ],
        mapError: (cause) => cause.message,
      });
      expect(result).toBe("claude-opus-5-5-medium");
      expect(modelCalls).toEqual(["claude-opus-5-5-medium"]);
      expect(configOptionCalls).toEqual([
        ["thought_level", "high"],
        ["speed", "fast"],
      ]);
    }),
  );

  it.effect("applies options without a model switch and skips unchanged or unoffered values", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, configOptionCalls } = makeRecordingRuntime(
        undefined,
        traitConfigOptions({ thoughtLevel: "high", speed: "fast" }),
      );
      yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "claude-opus-5-5-medium",
        requestedModelId: "claude-opus-5-5-medium",
        options: [
          { id: "reasoning", value: "high" },
          { id: "fastMode", value: false },
        ],
        mapError: (cause) => cause.message,
      });
      yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "claude-opus-5-5-medium",
        requestedModelId: undefined,
        options: [{ id: "reasoning", value: "xhigh" }],
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(configOptionCalls).toEqual([["speed", "standard"]]);
    }),
  );

  it.effect("propagates set_config_option failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyDevinAcpModelSelection({
          runtime,
          currentModelId: "swe-1-6-fast",
          requestedModelId: "swe-1-6",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});
