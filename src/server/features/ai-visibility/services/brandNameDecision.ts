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

// Every dash a number can be written with, folded to "-" first.
const DASHES = /[‐-―−]/g;
// The lookbehind means a match can only start at the start of a word, so a
// long run of letters or digits is scanned once (no quadratic backtracking).
const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g;
const AT_TOKEN = /\S*@\S*/g;

const EDGE_START = /^[([{"'‘“<*]+/;
const EDGE_END = /[.,;:!?)\]}"'’”>*]+$/;
const STREET_WORD =
  /^(?:st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|way|hwy|highway|cr|cres|crescent|pl|place|lane|ln|court|ct|crt|trail|pkwy|parkway|terrace|terr|close|circle|cir|circuit|ridge|gate|square|sq|plaza|rise|grove|point|pt|view|private|pvt)\.?$/i;
const UNIT_WORD =
  /^(?:years?|yrs|days?|hours?|hrs|weeks?|months?|minutes?|mins?|stars?|locations?|trucks?|km|miles?|percent)$/i;
const AGE_WORD = /^(?:over|under|aged?|ages|than)$/i;

function keepNumberToken(
  core: string,
  prev: string,
  next: string[],
  brandWords: Set<string>,
): boolean {
  const lower = core.toLowerCase();
  if (brandWords.has(lower)) return true; // the client's own name ("A1", "1-800-GOT-JUNK")
  if (/^(?:19|20)\d{2}[-/](?:19|20)?\d{2}$/.test(core) || core === "24/7")
    return true;
  if (/^\d{1,3}(?:%|\+)$/.test(core)) return true;
  if (
    /^\d{1,3}-[a-z]+$/i.test(core) &&
    UNIT_WORD.test(core.split("-")[1] ?? "")
  )
    return true;
  if (
    /^\d{1,3}$/.test(core) &&
    next[0] !== undefined &&
    UNIT_WORD.test(next[0])
  )
    return true;
  const letters = (core.match(/[A-Za-z]/g) ?? []).length;
  const digits = (core.match(/\d/g) ?? []).length;
  if (letters >= 3 && digits <= 2) return true; // "LGBTQ2S+", "COVID-19"
  const streetAhead = next.some((w) => STREET_WORD.test(w));
  if (/^\d{1,3}$/.test(core) && AGE_WORD.test(prev) && !streetAhead)
    return true;
  // a lone year, unless a number sits just before it (a phone's last group)
  // or a street word follows (a house number)
  if (/^(?:19|20)\d{2}$/.test(core) && !/\d/.test(prev) && !streetAhead)
    return true;
  return false;
}

/**
 * Jev is never sent contact details (standing rule). Emails and any token
 * with "@" are cut. Then every whitespace-separated token that contains a
 * digit becomes [number] (phones in any format, house, unit and box numbers
 * wherever they sit, postal codes), except years and year ranges, 24/7,
 * small counts with a unit ("7 days", "5-star", "100%"), ages, words like
 * "LGBTQ2S+", and any word of the client's own name or website. The text is
 * capped at MAX_JEV_ANSWER_CHARS first. The literal brand check runs on the
 * original text, before this.
 */
export function withoutContactDetails(
  text: string,
  brand = "",
  website = "",
): string {
  const brandWords = new Set(
    `${brand} ${website}`
      .toLowerCase()
      .replace(DASHES, "-")
      .split(/\s+/)
      .map((w) => w.replace(EDGE_START, "").replace(EDGE_END, ""))
      .filter((w) => /\d/.test(w)),
  );
  const cleaned = text
    .slice(0, MAX_JEV_ANSWER_CHARS)
    .replace(DASHES, "-")
    .replace(EMAIL, "[email]")
    .replace(AT_TOKEN, "[email]");
  const parts = cleaned.split(/(\s+)/);
  const words: number[] = [];
  parts.forEach((t, i) => {
    if (t && !/^\s+$/.test(t)) words.push(i);
  });
  const cores = words.map((i) =>
    (parts[i] ?? "").replace(EDGE_START, "").replace(EDGE_END, ""),
  );
  words.forEach((i, n) => {
    const token = parts[i] ?? "";
    if (!/\d/.test(token)) return;
    const core = cores[n] ?? "";
    if (
      keepNumberToken(
        core,
        cores[n - 1] ?? "",
        cores.slice(n + 1, n + 6),
        brandWords,
      )
    ) {
      return;
    }
    const lead = token.match(EDGE_START)?.[0] ?? "";
    const trail = token.match(EDGE_END)?.[0] ?? "";
    parts[i] = `${lead}[number]${trail}`;
  });
  return parts.join("");
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
      ai_answer: withoutContactDetails(text, brand, website),
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
