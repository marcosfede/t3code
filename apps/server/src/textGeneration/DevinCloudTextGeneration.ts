import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as TextGeneration from "./TextGeneration.ts";

/**
 * Devin Cloud runs each ACP session as a real remote Devin session, so using
 * it for git text generation would spin up a cloud session per commit message
 * or title. Cloud instances fail these requests with a clear error instead;
 * text generation routes to another configured provider.
 */
export function makeDevinCloudTextGeneration(): TextGeneration.TextGeneration["Service"] {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail:
          "Devin Cloud does not support git text generation. Select another provider for commit messages and titles.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  };
}
