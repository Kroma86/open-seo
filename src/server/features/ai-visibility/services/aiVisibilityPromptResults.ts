import { z } from "zod";

export const PROMPT_RESULT_ANSWER_MAX_CHARS = 1500;

// Stored run detail is our own JSON, but older runs predate fields such as
// nameProbability, so every field is optional and a bad shape reads as
// "not measured" instead of throwing.
const storedCitationSchema = z.object({
  url: z.string().nullish(),
  domain: z.string().nullish(),
  title: z.string().nullish(),
  matchedBrand: z.boolean().nullish(),
});

const storedModelResultSchema = z.object({
  status: z.string().nullish(),
  model: z.string().nullish(),
  text: z.string().nullish(),
  message: z.string().nullish(),
  citations: z.array(storedCitationSchema).nullish(),
  brandMentioned: z.boolean().nullish(),
  nameProbability: z.number().nullish(),
  nameUnsure: z.boolean().nullish(),
  nameSource: z.string().nullish(),
});

const storedDetailSchema = z.object({
  prompts: z.array(
    z.object({
      promptId: z.string(),
      prompt: z.string(),
      error: z.string().nullish(),
      results: z.array(storedModelResultSchema).nullish(),
    }),
  ),
});

export type PromptResultRow = {
  promptId: string;
  prompt: string;
  model: string | null;
  status: "success" | "error" | "not_measured";
  brandMentioned: boolean | null;
  nameProbability: number | null;
  nameSource: string | null;
  nameUnsure: boolean | null;
  error: string | null;
  citations: Array<{
    domain: string | null;
    url: string | null;
    title: string | null;
    matchedBrand: boolean | null;
  }>;
  answer: string | null;
  answerTruncated: boolean;
};

export type PromptResults = {
  measured: boolean;
  runId: string;
  completedAt: string | null;
  promptSetVersion: number | null;
  rows: PromptResultRow[];
  summary: {
    questionsChecked: number;
    questionsWithBrand: number;
    namedByModel: Record<string, number>;
  };
};

function emptyRow(
  prompt: { promptId: string; prompt: string },
  status: "error" | "not_measured",
  error: string | null,
): PromptResultRow {
  return {
    promptId: prompt.promptId,
    prompt: prompt.prompt,
    model: null,
    status,
    brandMentioned: null,
    nameProbability: null,
    nameSource: null,
    nameUnsure: null,
    error,
    citations: [],
    answer: null,
    answerTruncated: false,
  };
}

function toRow(
  prompt: { promptId: string; prompt: string },
  result: z.infer<typeof storedModelResultSchema>,
): PromptResultRow {
  const success = result.status === "success";
  const text = success ? (result.text ?? null) : null;
  return {
    promptId: prompt.promptId,
    prompt: prompt.prompt,
    model: result.model ?? null,
    status: success ? "success" : "error",
    // Never coerce an unmeasured answer to "not named".
    brandMentioned: success ? (result.brandMentioned ?? null) : null,
    nameProbability: success ? (result.nameProbability ?? null) : null,
    nameSource: success ? (result.nameSource ?? null) : null,
    nameUnsure: success ? (result.nameUnsure ?? null) : null,
    error: success ? null : (result.message ?? "Model check failed"),
    citations: (result.citations ?? []).map((citation) => ({
      domain: citation.domain ?? null,
      url: citation.url ?? null,
      title: citation.title ?? null,
      matchedBrand: citation.matchedBrand ?? null,
    })),
    answer: text?.slice(0, PROMPT_RESULT_ANSWER_MAX_CHARS) ?? null,
    answerTruncated: (text?.length ?? 0) > PROMPT_RESULT_ANSWER_MAX_CHARS,
  };
}

function parseDetail(detail: string | null) {
  if (!detail) return null;
  try {
    const parsed = storedDetailSchema.safeParse(JSON.parse(detail));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Per-question, per-model rows from a stored ai_visibility_runs.detail. */
export function extractPromptResults(
  detail: string | null,
  run: {
    runId: string;
    completedAt: string | null;
    promptSetVersion: number | null;
  },
): PromptResults {
  const parsed = parseDetail(detail);
  const rows =
    parsed?.prompts.flatMap((prompt) => {
      if (prompt.error) return [emptyRow(prompt, "error", prompt.error)];
      const results = prompt.results ?? [];
      if (results.length === 0) return [emptyRow(prompt, "not_measured", null)];
      return results.map((result) => toRow(prompt, result));
    }) ?? [];

  const checked = new Set<string>();
  const withBrand = new Set<string>();
  const namedByModel: Record<string, number> = {};
  for (const row of rows) {
    if (row.model) namedByModel[row.model] ??= 0;
    if (row.brandMentioned === null) continue;
    checked.add(row.promptId);
    if (!row.brandMentioned) continue;
    withBrand.add(row.promptId);
    if (row.model) namedByModel[row.model] += 1;
  }

  return {
    measured: parsed !== null,
    ...run,
    rows,
    summary: {
      questionsChecked: checked.size,
      questionsWithBrand: withBrand.size,
      namedByModel,
    },
  };
}

/** One text line per question: which models named the brand. */
export function formatPromptResultLines(results: PromptResults): string[] {
  if (!results.measured) {
    return [`Prompt results (run ${results.runId}): not measured`];
  }
  const byPrompt = new Map<string, PromptResultRow[]>();
  for (const row of results.rows) {
    byPrompt.set(row.promptId, [...(byPrompt.get(row.promptId) ?? []), row]);
  }
  const lines = [...byPrompt.values()].map((rows) => {
    const prompt = rows[0]?.prompt ?? "";
    if (rows.every((row) => row.brandMentioned === null)) {
      return `- ${prompt}: not measured`;
    }
    const named = rows
      .filter((row) => row.brandMentioned === true)
      .map((row) => row.model ?? "unknown model");
    return `- ${prompt}: named by ${named.length > 0 ? named.join(", ") : "none"}`;
  });
  return [`Prompt results (run ${results.runId}):`, ...lines];
}
