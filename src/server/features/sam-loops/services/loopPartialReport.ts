import { stripDraftEvidence } from "./monthlyContentResult";
import { z } from "zod";

type PartialStep = {
  text?: string;
  toolResults?: readonly { toolName: string; output?: unknown }[];
};

const readerSummary = z.object({
  summary: z.string(),
  error: z.unknown().optional(),
  isError: z.boolean().optional(),
});
const summaryReaders = new Set([
  "get_ai_visibility_trend",
  "get_audit_status",
  "get_audit_pages",
  "get_audit_issues",
  "get_agency_otto_page_inputs",
  "list_saved_keywords",
  "get_rank_tracker",
  "get_search_console_performance",
]);

/** Visible text only: never persist model reasoning or arbitrary tool payloads. */
export function loopPartialReport(
  steps: readonly PartialStep[],
  finalText = "",
): string {
  const observations = [
    ...new Set(
      [...steps.map((s) => s.text ?? ""), finalText]
        .map(stripDraftEvidence)
        .filter(Boolean),
    ),
  ];
  const tools = new Map<string, number>();
  const summaries: string[] = [];
  for (const step of steps)
    for (const result of step.toolResults ?? []) {
      tools.set(result.toolName, (tools.get(result.toolName) ?? 0) + 1);
      if (summaryReaders.has(result.toolName)) {
        const parsed = readerSummary.safeParse(result.output);
        if (parsed.success && !parsed.data.error && !parsed.data.isError) {
          summaries.push(
            `${result.toolName}: ${stripDraftEvidence(parsed.data.summary).slice(0, 800)}`,
          );
        }
      }
    }
  return [
    "INCOMPLETE — saved progress, not a completed report or verified article. No live improvement is claimed.",
    `Finished model steps: ${steps.length}.`,
    tools.size
      ? `Tool results received (not proof of success): ${[...tools].map(([name, n]) => `${name}: ${n}`).join(", ")}.`
      : "No tool results were recorded.",
    ...summaries.slice(-8),
    observations.length
      ? "Partial observations (unverified):\n" +
        observations.join("\n\n").slice(0, 12_000)
      : "No written observations were returned before interruption.",
  ].join("\n\n");
}
