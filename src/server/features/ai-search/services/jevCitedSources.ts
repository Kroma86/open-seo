import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import {
  countRealMentions,
  JEV_ABOUT_THIS_BUSINESS_QUESTION,
  JEV_RUN_CAP_USD,
  newJevSpendBudget,
  type JevSpendBudget,
} from "@/shared/real-mentions";

export const JEV_MODEL = "typesafe/jev-1.13";
export const JEV_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

/** Input price published for this model. Output tokens are free. */
const PRICE_PER_INPUT_TOKEN = 0.042 / 1_000_000;

const MAX_QUERIES = 8;
const MAX_QUERY_CHARS = 200;

export type CitedSourceForGrade = {
  url: string;
  domain?: string | null;
  keywords?: Array<{ question?: string | null }>;
};

export type GradedCitedSource<T> = T & { p: number | null };

export type JevGradeResult<T> = {
  sources: Array<GradedCitedSource<T>>;
  realMentions: number | null;
  /** Ticket name for the same count. */
  real_mentions: number | null;
  costUsd: number;
  calls: number;
  capped: boolean;
  /** True when there was no key, so nothing was asked. */
  unavailable: boolean;
};

export type JevPoster = (
  body: unknown,
  apiKey: string,
) => Promise<{ status: number; json: unknown }>;

export function searchQueriesForSource(
  source: CitedSourceForGrade,
  brandQuery?: string | null,
): string[] {
  const queries: string[] = [];
  for (const keyword of source.keywords ?? []) {
    const question = keyword.question?.trim();
    if (!question) continue;
    queries.push(question.slice(0, MAX_QUERY_CHARS));
    if (queries.length >= MAX_QUERIES) return queries;
  }
  if (queries.length === 0 && brandQuery?.trim()) {
    queries.push(brandQuery.trim().slice(0, MAX_QUERY_CHARS));
  }
  return queries;
}

/** One decisions-API body. The key is not part of this object. */
export function buildCitedSourceDecision(input: {
  businessName: string;
  website: string | null;
  source: CitedSourceForGrade;
  brandQuery?: string | null;
}) {
  return {
    model: JEV_MODEL,
    provider: { zdr: true as const },
    state: {
      business: {
        name: input.businessName.slice(0, 250),
        website: input.website,
      },
      cited_source: {
        url: input.source.url.slice(0, 2048),
        domain: input.source.domain ?? null,
      },
      search_queries: searchQueriesForSource(input.source, input.brandQuery),
    },
    questions: {
      q: {
        type: "noul" as const,
        instructions: JEV_ABOUT_THIS_BUSINESS_QUESTION,
      },
    },
  };
}

function estimateCostUsd(body: unknown): number {
  return (JSON.stringify(body).length / 3) * PRICE_PER_INPUT_TOKEN;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function readAnswer(json: unknown): { p: number | null; cost: number | null } {
  if (!json || typeof json !== "object") return { p: null, cost: null };
  const record = json as {
    answers?: { q?: { noul?: unknown } };
    usage?: { cost?: unknown; input_tokens?: unknown };
  };
  const noul = record.answers?.q?.noul;
  const p =
    typeof noul === "number" && Number.isFinite(noul) && noul >= 0 && noul <= 1
      ? noul
      : null;
  const reported = record.usage?.cost;
  if (
    typeof reported === "number" &&
    Number.isFinite(reported) &&
    reported >= 0
  ) {
    return { p, cost: reported };
  }
  const tokens = record.usage?.input_tokens;
  if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0) {
    return { p, cost: tokens * PRICE_PER_INPUT_TOKEN };
  }
  return { p, cost: null };
}

async function defaultPoster(
  body: unknown,
  apiKey: string,
): Promise<{ status: number; json: unknown }> {
  let lastStatus = 0;
  let lastJson: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(JEV_DECISIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "NiceSEO real mentions",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      lastStatus = response.status;
      try {
        lastJson = await response.json();
      } catch {
        lastJson = null;
      }
      if (
        response.ok ||
        ![408, 429, 500, 502, 503, 524, 529].includes(response.status)
      ) {
        return { status: lastStatus, json: lastJson };
      }
    } catch {
      lastStatus = 0;
      lastJson = null;
    }
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
  }
  return { status: lastStatus, json: lastJson };
}

/**
 * Ask Jev once per cited source. Stops before the next call once the
 * run's spend reaches $0.01. Failed calls are not treated as "no".
 */
export async function gradeCitedSources<T extends CitedSourceForGrade>(input: {
  businessName: string;
  website: string | null;
  brandQuery?: string | null;
  sources: T[];
  apiKey?: string | null;
  poster?: JevPoster;
  capUsd?: number;
  /** Mutated. One object shared by every brand in a weekly pass. */
  budget?: JevSpendBudget;
}): Promise<JevGradeResult<T>> {
  const budget =
    input.budget ?? newJevSpendBudget(input.capUsd ?? JEV_RUN_CAP_USD);
  const poster = input.poster ?? defaultPoster;
  const apiKey =
    input.apiKey === undefined
      ? ((await getOptionalEnvValue("OPENROUTER_API_KEY")) ?? null)
      : input.apiKey;

  if (!apiKey) {
    return {
      sources: input.sources.map((source) => ({ ...source, p: null })),
      realMentions: null,
      real_mentions: null,
      costUsd: 0,
      calls: 0,
      capped: false,
      unavailable: true,
    };
  }

  const graded: Array<GradedCitedSource<T>> = [];
  let costUsd = 0;
  let calls = 0;
  let capped = false;

  for (const source of input.sources) {
    const body = buildCitedSourceDecision({
      businessName: input.businessName,
      website: input.website,
      source,
      brandQuery: input.brandQuery,
    });
    const estimate = Math.max(estimateCostUsd(body), 0.0000001);
    // Hold back the next call using what the previous answered call cost,
    // not the tiny size estimate, so the shared weekly budget stays put.
    const reserve = Math.max(estimate, budget.lastCostUsd);
    if (
      capped ||
      budget.spentUsd >= budget.capUsd ||
      budget.spentUsd + reserve > budget.capUsd
    ) {
      capped = true;
      graded.push({ ...source, p: null });
      continue;
    }

    calls += 1;
    try {
      const response = await poster(body, apiKey);
      if (response.status < 200 || response.status >= 300) {
        graded.push({ ...source, p: null });
        continue;
      }
      const answer = readAnswer(response.json);
      const spent = answer.cost ?? estimate;
      costUsd += spent;
      budget.spentUsd += spent;
      budget.lastCostUsd = Math.max(budget.lastCostUsd, spent);
      graded.push({ ...source, p: answer.p });
      if (budget.spentUsd >= budget.capUsd) capped = true;
    } catch {
      graded.push({ ...source, p: null });
    }
  }

  const realMentions = countRealMentions(graded.map((source) => source.p));
  return {
    sources: graded,
    realMentions,
    real_mentions: realMentions,
    costUsd: roundUsd(costUsd),
    calls,
    capped,
    unavailable: false,
  };
}
