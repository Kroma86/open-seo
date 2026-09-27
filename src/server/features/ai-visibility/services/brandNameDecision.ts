/**
 * Decide whether one AI answer names the client.
 *
 * A literal match, after the punctuation cleanup below, is enough. Jev (a
 * cheap yes/no model) is only asked when the exact brand string is absent,
 * because that is where "Al's Appliance Inc." and similar wording was missed.
 * A link to the website, with no name, is not a literal match.
 */

export const JEV_MODEL = "typesafe/jev-1.13";
export const JEV_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
/** One weekly pass over the whole client list stays at or under this. */
export const WEEKLY_JEV_CAP_USD = 0.02;
/** Published Jev input price. Output tokens are not billed. */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export const NAMED_INSTRUCTIONS =
  "Does ai_answer mention the business described in business by its name? Count it when the answer names this exact business, even with small differences in punctuation, spacing, '&' vs 'and', or a missing word like 'Associates', 'Inc' or 'Photography'. Do NOT count a different business whose name only shares a word or a fragment with it. Do NOT count it when only the website link appears and the name does not.";

export type NameSource = "literal" | "jev" | "matcher_fallback";

export type NameGrade = {
  named: boolean;
  /** Null when Jev was not asked. */
  p: number | null;
  /** True when Jev was asked and 0.1 < p < 0.9. */
  unsure: boolean;
  source: NameSource;
};

export type NameBudget = {
  spentUsd: number;
  capUsd: number;
};

export type JevDecisionBody = {
  model: typeof JEV_MODEL;
  provider: { zdr: true };
  state: {
    business: { name: string; website: string };
    ai_answer: string;
  };
  questions: {
    named: { type: "noul"; instructions: string };
  };
};

export type JevNamedAnswer = {
  p: number;
  costUsd: number;
};

const HYPHENS = /[\u2010\u2011\u2013]/g;
const CURLY_APOSTROPHES = /[\u2018\u2019\u201B]/g;

/** Fold the hyphen and apostrophe characters the ticket names, and nothing else. */
export function normalizeForBrandMatch(value: string): string {
  return value.replace(HYPHENS, "-").replace(CURLY_APOSTROPHES, "'");
}

export function literalBrandInAnswer(text: string, brand: string): boolean {
  const needle = normalizeForBrandMatch(brand).trim().toLowerCase();
  if (!needle) return false;
  return normalizeForBrandMatch(text).toLowerCase().includes(needle);
}

export function jevDecisionBody(
  brand: string,
  website: string,
  text: string,
): JevDecisionBody {
  return {
    model: JEV_MODEL,
    provider: { zdr: true },
    state: {
      business: { name: brand, website },
      ai_answer: text,
    },
    questions: {
      named: { type: "noul", instructions: NAMED_INSTRUCTIONS },
    },
  };
}

/** Rough input-token cost, high rather than low, so the cap is not crossed. */
export function estimateJevCostUsd(body: JevDecisionBody): number {
  const tokens = Math.ceil(JSON.stringify(body).length / 4) + 32;
  return tokens * JEV_USD_PER_INPUT_TOKEN;
}

export function gradeFromProbability(p: number): {
  named: boolean;
  unsure: boolean;
} {
  return {
    named: p >= 0.5,
    unsure: p > 0.1 && p < 0.9,
  };
}

function fallbackGrade(named: boolean): NameGrade {
  return { named, p: null, unsure: false, source: "matcher_fallback" };
}

/**
 * Literal brand string → named, and Jev is not called.
 * Otherwise ask Jev. p >= 0.5 counts as named. 0.1 < p < 0.9 is unsure.
 * A failed or over-budget call keeps the previous matcher result.
 */
export async function gradeAnswerName(input: {
  brand: string;
  website: string;
  text: string;
  askJev?: (body: JevDecisionBody) => Promise<JevNamedAnswer>;
  fallbackNamed?: boolean;
  budget?: NameBudget;
}): Promise<NameGrade> {
  if (literalBrandInAnswer(input.text, input.brand)) {
    return { named: true, p: null, unsure: false, source: "literal" };
  }
  const fallbackNamed = input.fallbackNamed === true;
  if (!input.askJev) return fallbackGrade(fallbackNamed);

  const body = jevDecisionBody(input.brand, input.website, input.text);
  const estimate = estimateJevCostUsd(body);
  if (input.budget && input.budget.spentUsd + estimate > input.budget.capUsd) {
    return fallbackGrade(fallbackNamed);
  }

  try {
    const answer = await input.askJev(body);
    const p = answer?.p;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
      return fallbackGrade(fallbackNamed);
    }
    if (input.budget) {
      const charged =
        typeof answer.costUsd === "number" && answer.costUsd > 0
          ? answer.costUsd
          : estimate;
      input.budget.spentUsd += charged;
    }
    const graded = gradeFromProbability(p);
    return { named: graded.named, p, unsure: graded.unsure, source: "jev" };
  } catch {
    return fallbackGrade(fallbackNamed);
  }
}
