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
const keywordRows = z.array(
  z.object({
    keyword: z.string().refine((value) => value.trim().length > 0),
  }),
);
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
  const admitted: MonthlyEvidenceStep[] = [];
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
  // A failed read stays in the log. Only a clean reader may supply a topic.
  const admit = () => {
    const step = evidence[evidence.length - 1];
    if (step) admitted.push(step);
  };
  const selected = (): TopicResult | null => {
    const keyword = [...monthlyDemand(admitted)].find(
      ([key]) => !usedTopics.has(key),
    )?.[1];
    return keyword ? { status: "ready", keyword, evidence } : null;
  };
  const saved = await read("list_saved_keywords", { limit: 250 });
  const savedRows = keywordRows.safeParse(saved?.rows);
  if (!saved || saved.ok === false || !savedRows.success) unavailable = true;
  else {
    if (
      typeof saved.totalCount === "number" &&
      saved.totalCount > savedRows.data.length
    )
      unavailable = true;
    admit();
  }
  let target = selected();
  if (target) return target;

  // The list call is essential: a trackerId is needed only for the detail call.
  const list = await read("get_rank_tracker", {});
  const listFailed = list === null || list.ok === false;
  if (listFailed) unavailable = true;
  const external = z
    .object({ status: z.string() })
    .safeParse(list?.externalObservations);
  const externalPresent = list?.externalObservations != null;
  const externalStatusOk =
    external.success &&
    ["available", "missing"].includes(external.data.status);
  if (externalPresent && !externalStatusOk) unavailable = true;
  const importedRowsOk =
    !external.success ||
    external.data.status !== "available" ||
    keywordRows.safeParse(
      (list?.externalObservations as { rows?: unknown } | null)?.rows,
    ).success;
  if (!importedRowsOk) unavailable = true;
  const trackedRowsOk =
    list?.results == null ||
    z.object({ rows: keywordRows }).safeParse(list.results).success;
  if (!trackedRowsOk) unavailable = true;
  if (
    !listFailed &&
    (!externalPresent || externalStatusOk) &&
    importedRowsOk &&
    trackedRowsOk
  )
    admit();
  const configs = z
    .array(z.object({ id: z.string().min(1) }))
    .safeParse(list?.configs);
  if (!configs.success) unavailable = true;
  // Bound free DB/feed traffic; an incomplete scan must never claim NO DATA.
  if (configs.success && configs.data.length > 10) unavailable = true;
  target = selected();
  if (target) return target;
  if (!listFailed && configs.success) {
    for (const config of configs.data.slice(0, 10)) {
      const detail = await read("get_rank_tracker", { trackerId: config.id });
      const parsedRows = z
        .object({ rows: keywordRows })
        .safeParse(detail?.results);
      if (!detail || detail.ok === false || !parsedRows.success)
        unavailable = true;
      else admit();
      target = selected();
      if (target) return target;
    }
  }
  const gsc = await read("get_search_console_performance", {
    dimensions: ["query"],
    dateRange: "last_28_days",
    rowLimit: 100,
  });
  let gscClean = false;
  if (gsc?.ok === false) {
    if (
      !["not_connected", "gsc_oauth_not_configured"].includes(
        String(gsc.reason),
      )
    )
      unavailable = true;
    else gscClean = true;
  } else if (
    gsc?.ok !== true ||
    !Array.isArray(gsc.rows) ||
    !Array.isArray(gsc.dimensions) ||
    !gsc.dimensions.includes("query")
  ) {
    unavailable = true;
  } else {
    const index = gsc.dimensions.indexOf("query");
    gscClean = gsc.rows.every((row: unknown) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return false;
      const keys = (row as { keys?: unknown }).keys;
      const query = Array.isArray(keys) ? keys[index] : undefined;
      return typeof query === "string" && query.trim().length > 0;
    });
    if (!gscClean) unavailable = true;
  }
  if (
    gsc?.hasMore === true ||
    (Array.isArray(gsc?.rows) &&
      gsc.rows.length >= 100 &&
      gsc.hasMore !== false)
  )
    unavailable = true;
  if (gscClean) admit();
  const candidateCount = monthlyDemand(admitted).size;
  return (
    selected() ??
    (unavailable
      ? { status: "unavailable", evidence }
      : candidateCount
        ? { status: "no_new_topic", candidateCount, evidence }
        : { status: "no_data", evidence })
  );
}
