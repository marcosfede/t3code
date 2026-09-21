import type { DevinCloudCliSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { checkDevinCloudProviderStatus } from "./DevinCloudProvider.ts";

export const checkDevinCloudCliProviderStatus = (
  settings: DevinCloudCliSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  checkDevinCloudProviderStatus(settings, environment).pipe(
    Effect.map((snapshot) => ({ ...snapshot, displayName: "Devin Cloud (CLI)" })),
  );
