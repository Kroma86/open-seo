import type { AiVisibilitySweep } from "./aiVisibilitySweep";
import type { PromptExplorerModel } from "@/types/schemas/ai-search";

// getBrandLookup exposes no cache/paid signal, and any freshness heuristic
// mislabels in one direction or the other — say so honestly in both cases.
export function buildCostNote(input: {
  promptExplorerCalls: number;
  sweep: AiVisibilitySweep;
  models: PromptExplorerModel[];
  reusedFromRunId?: string;
}): string {
  const promptPart =
    input.promptExplorerCalls === 0
      ? null
      : `${input.promptExplorerCalls} prompt check(s): fresh (cache skipped)`;
  if (input.sweep === "pulse") {
    const engines =
      input.models.length === 0 ? "no prompt engines" : "perplexity sonar";
    const prefix = `pulse (${engines}); brand lookup reused from run ${input.reusedFromRunId ?? ""}`;
    return promptPart ? `${prefix}; ${promptPart}` : prefix;
  }
  const prefix = `full sweep (${input.models.length} engine(s): ${input.models.join(", ")})`;
  const brandLabel = "brand lookup cache/paid uncertain";
  return promptPart
    ? `${prefix}; ${brandLabel}; ${promptPart}`
    : `${prefix}; ${brandLabel}`;
}
