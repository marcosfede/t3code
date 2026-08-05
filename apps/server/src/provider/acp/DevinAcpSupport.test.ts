import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyDevinAcpModelSelection,
  buildDevinAcpSpawnInput,
  currentDevinModelIdFromSessionSetup,
  resolveDevinAcpBaseModelId,
  supportedDevinModelIdsFromSessionSetup,
} from "./DevinAcpSupport.ts";

describe("resolveDevinAcpBaseModelId", () => {
  it("keeps trimmed model ids and omits empty ones", () => {
    expect(resolveDevinAcpBaseModelId(undefined)).toBeUndefined();
    expect(resolveDevinAcpBaseModelId("   ")).toBeUndefined();
    expect(resolveDevinAcpBaseModelId("  swe-1-6-fast  ")).toBe("swe-1-6-fast");
  });
});

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
    });
  });

  it("falls back to `devin` on PATH and omits env when not provided", () => {
    const spawn = buildDevinAcpSpawnInput(null, "/tmp/project");

    expect(spawn).toEqual({
      command: "devin",
      args: ["acp"],
      cwd: "/tmp/project",
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

describe("applyDevinAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<string> = [];
    const runtime = {
      setModel: (model: string) =>
        Effect.gen(function* () {
          modelCalls.push(model);
          if (failure) return yield* failure;
        }),
    };
    return { runtime, modelCalls };
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
