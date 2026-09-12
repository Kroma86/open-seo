/** True when propose_homegrown_otto_fixes returned a queued proposal, not an error. */
export function isSuccessfulProposeOutput(output: unknown): boolean {
  if (output == null || typeof output !== "object") return false;
  const record = output as Record<string, unknown>;
  if ("error" in record && record.error != null) return false;
  const data = record.data;
  if (data != null && typeof data === "object" && "id" in data) {
    return typeof (data as { id: unknown }).id === "string";
  }
  return typeof record.summary === "string" && /queued/i.test(record.summary);
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
