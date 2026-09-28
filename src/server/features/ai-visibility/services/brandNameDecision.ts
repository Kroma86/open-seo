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
/**
 * One weekly pass over the whole client list stays at or under this. The
 * 23 Sep answers (336, 253 needing Jev) cost $0.0112, so this leaves room for
 * about 4x more clients before answers fall back to the matcher.
 */
export const WEEKLY_JEV_CAP_USD = 0.05;
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
  /** Consecutive failed Jev calls in this pass (shared like the spend). */
  failures?: number;
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

/** Longest answer text sent to Jev. The 23 Sep answers peak at 5,380 characters. */
export const MAX_JEV_ANSWER_CHARS = 12_000;
/** Consecutive failed Jev calls after which the rest of the pass uses the matcher. */
export const MAX_JEV_FAILURES = 3;

// Every dash a phone number can be written with, folded to "-" before the
// phone check so "250‑545‑1234" can't slip through in pieces.
const DASHES = /[‐-―−]/g;
// The lookbehind means a match can only start at the start of a word, so a
// long run of letters or digits is scanned once (no quadratic backtracking).
const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g;
const PHONE_SHAPE = /\+?\d[\d\s().\-/]{5,}\d/g;
// Only the house number goes: a number followed, within 4 words, by a street
// word ("3101 30 ave", "2900 North West Kalamalka Lake Road"). The street
// name stays, because a business can be named after its street
// ("Setanta Landscapes Way") and Jev must still see that name.
const HOUSE_NUMBER =
  /\b\d{1,6}[A-Za-z]?(?=(?:\s+[\w.'’-]+){0,4}\s+(?:st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|way|hwy|highway|cres|crescent|pl|place|lane|ln|court|ct|trail|pkwy|parkway|terrace|close|circle|cir)\b)/gi;

/**
 * Jev is never sent contact details (standing rule): email addresses and
 * phone numbers (7 or more digits) become [email] / [phone], and house
 * numbers become [number]. The text is capped at MAX_JEV_ANSWER_CHARS first.
 * The literal brand check runs on the original text, before this.
 */
export function withoutContactDetails(text: string): string {
  return text
    .slice(0, MAX_JEV_ANSWER_CHARS)
    .replace(DASHES, "-")
    .replace(EMAIL, "[email]")
    .replace(PHONE_SHAPE, (m) =>
      m.replace(/\D/g, "").length >= 7 ? "[phone]" : m,
    )
    .replace(HOUSE_NUMBER, "[number]");
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
      ai_answer: withoutContactDetails(text),
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

  // After MAX_JEV_FAILURES failed calls in a row (Jev down or hanging), stop
  // asking for the rest of the pass so a dead Jev costs at most 3 timeouts.
  if (input.budget && (input.budget.failures ?? 0) >= MAX_JEV_FAILURES) {
    return fallbackGrade(fallbackNamed);
  }
  const body = jevDecisionBody(input.brand, input.website, input.text);
  const estimate = estimateJevCostUsd(body);
  if (input.budget && input.budget.spentUsd + estimate > input.budget.capUsd) {
    return fallbackGrade(fallbackNamed);
  }
  const failed = () => {
    if (input.budget) input.budget.failures = (input.budget.failures ?? 0) + 1;
    return fallbackGrade(fallbackNamed);
  };

  try {
    const answer = await input.askJev(body);
    const p = answer?.p;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
      return failed();
    }
    if (input.budget) {
      input.budget.failures = 0;
      const charged =
        typeof answer.costUsd === "number" && answer.costUsd > 0
          ? answer.costUsd
          : estimate;
      input.budget.spentUsd += charged;
    }
    const graded = gradeFromProbability(p);
    return { named: graded.named, p, unsure: graded.unsure, source: "jev" };
  } catch {
    return failed();
  }
}
