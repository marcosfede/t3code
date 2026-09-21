import type { DevinCloudCliSettings } from "@t3tools/contracts";

import type { DevinAcpRuntimeFactoryInput } from "./DevinAcpSupport.ts";
import { makeDevinCloudAcpRuntime } from "./DevinCloudAcpSupport.ts";

export const makeDevinCloudCliAcpRuntime = (
  input: DevinAcpRuntimeFactoryInput & {
    readonly settings: Pick<DevinCloudCliSettings, "binaryPath" | "organizationId">;
  },
) =>
  makeDevinCloudAcpRuntime({
    ...input,
    cloudSettings: input.settings,
    ...(input.settings.organizationId ? { organizationId: input.settings.organizationId } : {}),
  });
