import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { DevinCloudSessionImportResult, EnvironmentId } from "@t3tools/contracts";
import type { useNavigate } from "@tanstack/react-router";

import { waitForThreadShell } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { toastManager } from "../ui/toast";

/** Focuses the T3 thread an opened Devin session lives in. Archived threads stay archived. */
export async function focusDevinImport(
  navigate: ReturnType<typeof useNavigate>,
  environmentId: EnvironmentId,
  result: DevinCloudSessionImportResult,
): Promise<void> {
  if (result.archived) {
    toastManager.add({
      type: "info",
      title: "This session is archived in T3",
      description: "Unarchive it here to pick it back up.",
    });
    await navigate({ to: "/settings/archived" });
    return;
  }
  const threadRef = scopeThreadRef(environmentId, result.threadId);
  // The thread route redirects away from threads the client has not seen yet.
  if (!(await waitForThreadShell(threadRef, 10_000))) {
    throw new Error("The thread did not appear in the app.");
  }
  await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
}
