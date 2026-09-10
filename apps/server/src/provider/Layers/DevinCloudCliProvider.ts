import type { DevinCloudCliSettings } from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeDevinCloudCliAcpRuntime } from "../acp/DevinCloudCliAcpSupport.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ProviderProbeResult,
} from "../providerSnapshot.ts";
import { buildInitialDevinCloudProviderSnapshot } from "./DevinCloudProvider.ts";

export const checkDevinCloudCliProviderStatus = Effect.fn("checkDevinCloudCliProviderStatus")(
  function* (settings: DevinCloudCliSettings, environment: NodeJS.ProcessEnv = process.env) {
    const initial = yield* buildInitialDevinCloudProviderSnapshot(settings);
    const snapshot = (probe: ProviderProbeResult) =>
      buildServerProvider({
        presentation: {
          displayName: "Devin Cloud (CLI)",
          badgeLabel: "Early Access",
          showInteractionModeToggle: false,
          requiresNewThreadForModelChange: false,
        },
        enabled: settings.enabled,
        checkedAt: initial.checkedAt,
        models: initial.models,
        probe,
      });
    if (!settings.enabled) {
      return snapshot({
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Devin Cloud (CLI) is disabled in T3 Code settings.",
      });
    }

    const binaryPath = settings.binaryPath || "devin-insiders";
    const versionResult = yield* Effect.gen(function* () {
      const spawn = yield* resolveSpawnCommand(binaryPath, ["--version"], { env: environment });
      return yield* spawnAndCollect(
        binaryPath,
        ChildProcess.make(spawn.command, spawn.args, { env: environment, shell: spawn.shell }),
      );
    }).pipe(Effect.timeoutOption("4 seconds"), Effect.result);
    if (Result.isFailure(versionResult)) {
      const missing = isCommandMissingCause(versionResult.failure);
      return snapshot({
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "Devin Cloud CLI is not installed or not on PATH. Install devin-insiders or configure its binary path."
          : "Failed to execute the Devin Cloud CLI version check.",
      });
    }
    if (Option.isNone(versionResult.success) || versionResult.success.value.code !== 0) {
      return snapshot({
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin Cloud CLI failed or timed out while checking its version.",
      });
    }
    const output = versionResult.success.value;
    const version = parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);
    const probe = yield* Effect.gen(function* () {
      const runtime = yield* makeDevinCloudCliAcpRuntime({
        settings,
        environment,
        childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        cwd: process.cwd(),
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
      });
      return yield* runtime.initialize();
    }).pipe(Effect.scoped, Effect.timeoutOption("10 seconds"), Effect.exit);
    if (Exit.isFailure(probe) || Option.isNone(probe.value)) {
      if (Exit.isFailure(probe)) {
        yield* Effect.logWarning("Devin Cloud CLI initialization failed", {
          errorTag: causeErrorTag(probe.cause),
        });
      }
      return snapshot({
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Devin Cloud CLI could not connect. Sign in with `devin-insiders auth login` (or your configured CLI), and use a version supporting `acp --cloud`.",
      });
    }
    return snapshot({
      installed: true,
      version,
      status: "ready",
      auth: { status: "authenticated" },
    });
  },
);
