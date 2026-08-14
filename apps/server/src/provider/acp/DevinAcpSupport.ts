import { type DevinSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type DevinAcpRuntimeDevinSettings = Pick<DevinSettings, "binaryPath">;

interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn" | "webSocket"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeDevinSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

/** Runtime factory input without provider-specific settings; what the shared
 * Devin adapter passes when it needs an ACP runtime for a session. */
export type DevinAcpRuntimeFactoryInput = Omit<DevinAcpRuntimeInput, "devinSettings">;

export type DevinAcpRuntimeFactory = (
  input: DevinAcpRuntimeFactoryInput,
) => Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
>;

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: devinSettings?.binaryPath || "devin",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

/**
 * Devin's only ACP auth method (`devin-browser`) launches an interactive
 * browser login, so the runtime never calls `authenticate` eagerly
 * (`authMethodId: null`). Sessions run on the CLI's cached credentials; an
 * unauthenticated CLI surfaces through the provider health probe instead.
 */
export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(input.devinSettings, input.cwd, input.environment),
        authMethodId: null,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveDevinAcpBaseModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

type DevinSessionSetupResult =
  | EffectAcpSchema.LoadSessionResponse
  | EffectAcpSchema.NewSessionResponse
  | EffectAcpSchema.ResumeSessionResponse;

/** The negotiated model select option. Local Devin sessions advertise it as
 * `model`; cloud sessions advertise it as `devin_version`. */
export function findDevinModelConfigOption(sessionSetupResult: DevinSessionSetupResult) {
  return sessionSetupResult.configOptions?.find(
    (option) =>
      option.category === "model" || option.id === "model" || option.id === "devin_version",
  );
}

export function devinModelConfigOptionIdFromSessionSetup(
  sessionSetupResult: DevinSessionSetupResult,
): string | undefined {
  return findDevinModelConfigOption(sessionSetupResult)?.id;
}

export function currentDevinModelIdFromSessionSetup(
  sessionSetupResult: DevinSessionSetupResult,
): string | undefined {
  const fromModels = sessionSetupResult.models?.currentModelId?.trim();
  if (fromModels) {
    return fromModels;
  }
  const modelOption = findDevinModelConfigOption(sessionSetupResult);
  if (!modelOption || modelOption.type !== "select") {
    return undefined;
  }
  return typeof modelOption.currentValue === "string"
    ? modelOption.currentValue.trim() || undefined
    : undefined;
}

/**
 * Model IDs the negotiated session accepts, from the `model` select option
 * (flat or grouped). Returns `undefined` when the session exposes no model
 * option, meaning acceptance is unknown rather than empty.
 */
export function supportedDevinModelIdsFromSessionSetup(
  sessionSetupResult: DevinSessionSetupResult,
): ReadonlySet<string> | undefined {
  const modelOption = findDevinModelConfigOption(sessionSetupResult);
  if (!modelOption || modelOption.type !== "select") {
    return undefined;
  }
  const ids = new Set<string>();
  for (const entry of modelOption.options) {
    const options = "group" in entry ? entry.options : [entry];
    for (const option of options) {
      const value = option.value.trim();
      if (value) {
        ids.add(value);
      }
    }
  }
  return ids;
}

/**
 * Selects the Devin base model through the negotiated `model` config option.
 * No-ops when nothing was requested or the requested model is already active.
 * When the session advertises its accepted models and the requested one is
 * not among them (e.g. Free-tier sessions only accept a subset of discovered
 * models), keeps the session's current model instead of failing the turn.
 */
export function applyDevinAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "setModel" | "setConfigOption"
  >;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly supportedModelIds?: ReadonlySet<string> | undefined;
  /** Negotiated model config option id; when set, selection goes through
   * `session/set_config_option` with this id (cloud sessions use
   * `devin_version` rather than `model`). */
  readonly modelConfigOptionId?: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const requestedIsSupported =
    input.supportedModelIds === undefined ||
    (input.requestedModelId !== undefined && input.supportedModelIds.has(input.requestedModelId));
  const shouldSwitchModel =
    input.requestedModelId !== undefined &&
    input.requestedModelId !== input.currentModelId &&
    requestedIsSupported;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  const applySelection =
    input.modelConfigOptionId !== undefined
      ? Effect.asVoid(
          input.runtime.setConfigOption(input.modelConfigOptionId, input.requestedModelId),
        )
      : input.runtime.setModel(input.requestedModelId);
  return applySelection.pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}
