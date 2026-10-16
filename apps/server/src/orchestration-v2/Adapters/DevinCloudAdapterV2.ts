import {
  DEVIN_CLOUD_DEFAULT_MODEL,
  DevinCloudSettings,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  findDevinCloudModelOption,
  makeDevinCloudAcpRuntime,
  selectConfigOptionChoices,
  withDevinCloudOrganizationLock,
} from "../../provider/acp/DevinCloudAcpSupport.ts";
import {
  makeDevinCloudReferenceRewriter,
  normalizeDevinCloudUserMessage,
} from "../../provider/acp/DevinReferences.ts";
import { makeDevinCloudReconnect } from "../../provider/acp/DevinCloudReconnect.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import {
  extractDevinSubagentUpdate,
  normalizeDevinSessionUpdate,
  normalizeDevinToolCall,
} from "@t3tools/provider-acp-registry/server/devinAcp";

export const DEVIN_CLOUD_PROVIDER = ProviderDriverKind.make("devinCloud");

const DEFAULT_DEVIN_CLOUD_SETTINGS = Schema.decodeSync(DevinCloudSettings)({});

export interface DevinCloudAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: DevinCloudSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  /** Observes the model and organization pickers each Cloud session advertises. */
  readonly onConfigOptions?: (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  ) => Effect.Effect<void>;
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    Crypto.Crypto | Scope.Scope
  >;
}

/**
 * Cloud sessions run on Devin's machines, so local MCP servers and client
 * terminals are not offered to them.
 */
function makeDevinCloudRuntime(options: DevinCloudAdapterV2Options) {
  return (input: AcpAdapterV2RuntimeInput) =>
    Effect.gen(function* () {
      const {
        processEnvironment: _processEnvironment,
        acpMcpServers: _acpMcpServers,
        runtimePolicy: _runtimePolicy,
        ...runtimeInput
      } = input;
      const runtime = yield* makeDevinCloudReconnect(runtimeInput, (connection) =>
        makeDevinCloudAcpRuntime({
          ...runtimeInput,
          ...connection,
          mcpServers: [],
          settings: options.settings,
          environment: options.environment,
          childProcessSpawner: options.childProcessSpawner,
        }),
      );
      return yield* withDevinCloudOrganizationLock(runtime, {
        ...(input.resumeSessionId === undefined ? {} : { resumeSessionId: input.resumeSessionId }),
        ...(options.settings.organizationId
          ? { organizationId: options.settings.organizationId }
          : {}),
      });
    });
}

const applyDevinCloudModelSelection: NonNullable<AcpAdapterV2Flavor["applyModelSelection"]> = ({
  runtime,
  modelSelection,
}) =>
  Effect.gen(function* () {
    const model = modelSelection.model.trim();
    if (!model || model === DEVIN_CLOUD_DEFAULT_MODEL) return undefined;
    const option = findDevinCloudModelOption(yield* runtime.getConfigOptions);
    if (option === undefined) return undefined;
    if (option.currentValue === model) return model;
    if (!selectConfigOptionChoices(option).some((choice) => choice.value === model)) {
      yield* Effect.logWarning("Devin Cloud does not offer the requested model", { model });
      return undefined;
    }
    yield* runtime.setConfigOption(option.id, model);
    return model;
  });

export const makeDevinCloudAdapterV2 = Effect.fn("makeDevinCloudAdapterV2")(function* (
  options: DevinCloudAdapterV2Options,
) {
  const rewriteReferences = makeDevinCloudReferenceRewriter();
  const flavor: AcpAdapterV2Flavor = {
    driver: DEVIN_CLOUD_PROVIDER,
    capabilities: AcpProviderCapabilitiesV2,
    clientCapabilitiesMeta: {
      "cognition.ai/subagentSupport": true,
      "cognition.ai/messageGrouping": true,
    },
    normalizeSessionUpdate: (notification) =>
      rewriteReferences(normalizeDevinCloudUserMessage(normalizeDevinSessionUpdate(notification))),
    normalizeToolCall: normalizeDevinToolCall,
    extractSubagentUpdate: extractDevinSubagentUpdate,
    makeRuntime: options.makeRuntime ?? makeDevinCloudRuntime(options),
    applyModelSelection: applyDevinCloudModelSelection,
    ...(options.onConfigOptions === undefined
      ? {}
      : {
          onSessionConfigurationUpdate: (configOptions) => options.onConfigOptions!(configOptions),
        }),
  };
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor,
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging ? { nativeLogging: options.nativeLogging } : {}),
  });
});

export type DevinCloudAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const makeDevinCloudAdapterV2FromServices = Effect.fn("makeDevinCloudAdapterV2FromServices")(
  function* (
    input: ProviderAdapterDriverCreateInput<DevinCloudSettings>,
    hooks: Pick<DevinCloudAdapterV2Options, "onConfigOptions">,
  ) {
    const hostEnvironment = yield* HostProcess.Environment;
    const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
    return yield* makeDevinCloudAdapterV2({
      instanceId: input.instanceId,
      settings: { ...input.config, enabled: input.enabled },
      environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
      childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      selfInvocation: yield* resolveSelfInvocation(),
      nativeLogging: (threadId) =>
        makeNativeLogger({
          nativeEventLogger: providerEventLoggers.native,
          provider: DEVIN_CLOUD_PROVIDER,
          threadId,
        }),
      ...hooks,
    });
  },
  (effect, input) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterDriverCreateError({
            driver: DEVIN_CLOUD_PROVIDER,
            instanceId: input.instanceId,
            detail: "Failed to create Devin Cloud ACP adapter.",
            cause,
          }),
      ),
    ),
);

export const DevinCloudAdapterV2Driver: ProviderAdapterDriver<
  DevinCloudSettings,
  DevinCloudAdapterV2DriverEnv
> = {
  driverKind: DEVIN_CLOUD_PROVIDER,
  configSchema: DevinCloudSettings,
  defaultConfig: (): DevinCloudSettings => DEFAULT_DEVIN_CLOUD_SETTINGS,
  create: (input) => makeDevinCloudAdapterV2FromServices(input, {}),
};
