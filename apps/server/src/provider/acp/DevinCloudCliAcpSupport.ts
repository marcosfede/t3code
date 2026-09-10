import type { DevinCloudCliSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { buildDevinAcpSpawnInput, type DevinAcpRuntimeFactoryInput } from "./DevinAcpSupport.ts";
import { makeDevinCloudReconnect } from "./DevinCloudReconnect.ts";

export const makeDevinCloudCliAcpRuntime = (
  input: DevinAcpRuntimeFactoryInput & {
    readonly settings: Pick<DevinCloudCliSettings, "binaryPath">;
  },
) =>
  makeDevinCloudReconnect(input, (connectionOptions) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          ...input,
          ...connectionOptions,
          spawn: {
            ...buildDevinAcpSpawnInput(
              { binaryPath: input.settings.binaryPath || "devin-insiders" },
              input.cwd,
              input.environment,
            ),
            args: ["acp", "--cloud"],
          },
          authMethodId: null,
          sessionLoadReplayIdleGap: null,
        }).pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
          ),
        ),
      );
      return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
    }),
  );
