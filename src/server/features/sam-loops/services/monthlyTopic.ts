import type { ToolSet } from "ai";
import { z } from "zod";
import {
  monthlyDemand,
  type MonthlyEvidenceStep,
} from "./monthlyContentResult";

const envelope = z.object({
  error: z.unknown().optional(),
  isError: z.boolean().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
type TopicResult =
  | { status: "ready"; keyword: string; evidence: MonthlyEvidenceStep[] }
  | {
      status: "no_new_topic";
      candidateCount: number;
      evidence: MonthlyEvidenceStep[];
    }
  | { status: "no_data" | "unavailable"; evidence: MonthlyEvidenceStep[] };

/** All tools here are scoped free readers. No inference, tracker runs or paid research. */
export async function selectMonthlyTopic(
  tools: ToolSet,
  usedTopics: ReadonlySet<string> = new Set(),
): Promise<TopicResult> {
  const evidence: MonthlyEvidenceStep[] = [];
  let unavailable = false;
  const read = async (name: string, args: Record<string, unknown>) => {
    try {
      const tool = tools[name];
      if (!tool?.execute) throw new Error("Reader unavailable");
      const output = await tool.execute(args, {
        toolCallId: `monthly-topic-${evidence.length}`,
        messages: [],
      });
      evidence.push({ toolResults: [{ toolName: name, output }] });
      const parsed = envelope.safeParse(output);
      if (
        !parsed.success ||
        parsed.data.error ||
        parsed.data.isError ||
        !parsed.data.data ||
        parsed.data.data.error
      )
        throw new Error("Reader unavailable");
      return parsed.data.data;
    } catch {
      unavailable = true;
      return null;
    }
  };
  const selected = (): TopicResult | null => {
    const keyword = [...monthlyDemand(evidence)].find(
      ([key]) => !usedTopics.has(key),
    )?.[1];
    return keyword ? { status: "ready", keyword, evidence } : null;
  };
  const saved = await read("list_saved_keywords", { limit: 250 });
  if (saved && !Array.isArray(saved.rows)) unavailable = true;
  if (
    saved &&
    Array.isArray(saved.rows) &&
    typeof saved.totalCount === "number" &&
    saved.totalCount > saved.rows.length
  )
    unavailable = true;
  let target = selected();
  if (target) return target;

  // The list call is essential: a trackerId is needed only for the detail call.
  const list = await read("get_rank_tracker", {});
  const external = z
    .object({ status: z.string() })
    .safeParse(list?.externalObservations);
  if (
    list?.externalObservations != null &&
    (!external.success ||
      !["available", "missing"].includes(external.data.status))
  )
    unavailable = true;
  target = selected();
  if (target) return target;
  const configs = z
    .array(z.object({ id: z.string().min(1) }))
    .safeParse(list?.configs);
  if (!configs.success) unavailable = true;
  if (configs.success) {
    // Bound free DB/feed traffic; an incomplete scan must never claim NO DATA.
    if (configs.data.length > 10) unavailable = true;
    for (const config of configs.data.slice(0, 10)) {
      const detail = await read("get_rank_tracker", { trackerId: config.id });
      const result = z
        .object({ rows: z.array(z.unknown()) })
        .safeParse(detail?.results);
      if (!result.success) unavailable = true;
      target = selected();
      if (target) return target;
    }
  }
  const gsc = await read("get_search_console_performance", {
    dimensions: ["query"],
    dateRange: "last_28_days",
    rowLimit: 100,
  });
  if (gsc?.ok === false) {
    if (
      !["not_connected", "gsc_oauth_not_configured"].includes(
        String(gsc.reason),
      )
    )
      unavailable = true;
  } else if (
    gsc?.ok !== true ||
    !Array.isArray(gsc.rows) ||
    !Array.isArray(gsc.dimensions) ||
    !gsc.dimensions.includes("query")
  ) {
    unavailable = true;
  }
  if (
    gsc?.hasMore === true ||
    (Array.isArray(gsc?.rows) &&
      gsc.rows.length >= 100 &&
      gsc.hasMore !== false)
  )
    unavailable = true;
  const candidateCount = monthlyDemand(evidence).size;
  return (
    selected() ??
    (unavailable
      ? { status: "unavailable", evidence }
      : candidateCount
        ? { status: "no_new_topic", candidateCount, evidence }
        : { status: "no_data", evidence })
  );
}
