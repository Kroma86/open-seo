/** True when propose_homegrown_otto_fixes returned a queued proposal, not an error. */
export function isSuccessfulProposeOutput(output: unknown): boolean {
  if (output == null || typeof output !== "object") return false;
  if ("error" in output && output.error != null) return false;
  const data = "data" in output ? output.data : undefined;
  if (data != null && typeof data === "object" && "id" in data) {
    return typeof data.id === "string";
  }
  const summary = "summary" in output ? output.summary : undefined;
  return typeof summary === "string" && /queued/i.test(summary);
}

/** Count successful propose_homegrown_otto_fixes results (not mere call attempts). */
export function countProposalsQueued(
  steps: Array<{
    toolResults?: Array<{ toolName: string; output?: unknown }>;
  }>,
): number {
  let count = 0;
  for (const step of steps) {
    for (const result of step.toolResults ?? []) {
      if (result.toolName !== "propose_homegrown_otto_fixes") continue;
      if (isSuccessfulProposeOutput(result.output)) count += 1;
    }
  }
  return count;
}
