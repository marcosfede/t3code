import * as Effect from "effect/Effect";
import { TextGenerationError } from "@t3tools/contracts";

import type * as TextGeneration from "./TextGeneration.ts";

/** Devin Cloud runs remote sessions; it never creates one just to write a title or commit. */
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
