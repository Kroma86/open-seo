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
// A token that is, or hides, an email: "@", "%40", "(at)", "[at]", "{at}", "<at>", "*at*".
const EMAIL_TOKEN = /@|%40|[-([{<*]\s*at\s*[-)\]}>*]/i;
const AT_WORD = /^(?:at|@|[-([{<*]at[-)\]}>*])$/i;
// "(@)", "[.]", "{dot}", "*at*", "/at/": a marker wrapped in brackets, stars or
// slashes is unwrapped to a spaced word first, so every wrapper reads alike.
const WRAPPED_MARKER = /[[({<*/]\s*(@|at|dot|\.)\s*[\])}>*/]/gi;
const DOT_WORD = /^(?:\.|dot|[-([{<*]dot[-)\]}>*])$/i;
const DOT_TLD_WORD = /^dot(?:com|ca|net|org|info|biz|io|co|us|app|ai)$/i;
// A web address or domain: "gmail.com", "dept.company.co.uk", ".com",
// "https://x.ca/a". Cut unless it is the client's own website.
const DOMAIN_LIKE =
  /^(?:[a-z][a-z0-9+.-]*:\/\/\S*|[\w.-]*\.[a-z]{2,}(?:[/?#]\S*)?)$/i;

const EDGE_START = /^[([{"'‘“<*]+/;
const EDGE_END = /[.,;:!?)\]}"'’”>*]+$/;
// Terms that contain a digit but can never be a contact detail.
const SAFE_TERMS = new Set([
  "24/7",
  "lgbtq2s+",
  "lgbtq2s",
  "2slgbtq+",
  "2slgbtqia+",
  "lgbtq2sia+",
  "covid-19",
  "b2b",
  "b2c",
]);

const alnum = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "");
const isSubsequence = (short: string, long: string) => {
  let j = 0;
  for (const ch of long) if (ch === short[j]) j += 1;
  return j === short.length;
};

/**
 * Jev is never sent contact details (standing rule). The rule is structural,
 * so no number format or email spelling can slip through:
 * - the text is NFKC-normalised first (fullwidth "＠" and "．" become "@" "."
 *   and are caught like any other);
 * - every whitespace-separated token that contains a digit becomes [number],
 *   except a few fixed terms (24/7, LGBTQ2S+, COVID-19, B2B) and the client's
 *   own numbered name (see brandToken);
 * - every token that holds "@", "%40" or a bracketed "at" becomes [email],
 *   with the words either side of a lone "@";
 * - every web address or domain becomes [email] unless it is the client's own
 *   website, and a spelled address (a word, "at", then within 8 words a
 *   domain, a dot word or "dotcom") is cut from the word before "at" on;
 * - over-cutting ordinary numbers and links is accepted.
 * The text is capped at MAX_JEV_ANSWER_CHARS first. The literal brand check
 * runs on the original text, before this.
 */
export function withoutContactDetails(
  text: string,
  brand = "",
  website = "",
): string {
  const norm = (v: string) => v.normalize("NFKC").replace(DASHES, "-");
  const brandFull = alnum(norm(brand));
  const brandPieces = norm(brand)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const brandDigits = new Set(brandPieces.filter((w) => /^\d+$/.test(w)));
  const brandLetters = new Set(brandPieces.filter((w) => /^[a-z]+$/.test(w)));
  const brandWords = norm(`${brand} ${website}`)
    .split(/\s+/)
    .map(alnum)
    .filter((w) => /\d/.test(w));
  const site = alnum(
    website.replace(/^https?:\/\//i, "").replace(/^www\./i, ""),
  );
  // The client's own numbered name, when the token has letters: the whole
  // brand or its start ("Play2Learn", "1800-GOT-JUNK"), a numbered brand word
  // alone or with "s", or with the next brand word abbreviated ("24hr" for
  // "24 Hour"). A token of digits only is never kept here (r5): "24", "18" or
  // "180" alone could be a house or unit number. The start of the brand
  // needs 2+ letters (r6): "2B", "24H", "5S", "A1" read as unit numbers
  // ("A1 Plumbing" is still kept, by the next-word rule below).
  const brandToken = (c: string) => {
    const a = alnum(c);
    if (!a || !/[a-z]/.test(a)) return false;
    const letters = a.replace(/[^a-z]/g, "").length;
    if (
      a.length >= 2 &&
      brandFull.startsWith(a) &&
      (letters >= 2 || a === brandFull)
    )
      return true;
    return brandWords.some((w) => {
      if (!a.startsWith(w)) return false;
      const rest = a.slice(w.length);
      // a plural "s" only on a brand word with letters: "5S" is a unit (r6)
      if (rest === "" || (rest === "s" && /[a-z]/.test(w))) return true;
      const next = brandFull
        .slice(brandFull.indexOf(w) + w.length)
        .replace(/^\d+/, "");
      return (
        rest.length >= 2 &&
        /^[a-z]+$/.test(rest) &&
        rest[0] === next[0] &&
        isSubsequence(rest, next)
      );
    });
  };
  const parts = norm(text.slice(0, MAX_JEV_ANSWER_CHARS))
    .replace(WRAPPED_MARKER, " $1 ")
    .replace(EMAIL, "[email]")
    .split(/(\s+)/);
  const words: number[] = [];
  parts.forEach((t, i) => {
    if (t && !/^\s+$/.test(t)) words.push(i);
  });
  const core = (i: number) =>
    (parts[i] ?? "").replace(EDGE_START, "").replace(EDGE_END, "");
  const coreAt = (n: number) => core(words[n] as number);
  const isDomain = (c: string) =>
    DOMAIN_LIKE.test(c) && !(site && alnum(c).includes(site));
  const cut = new Set<number>();
  words.forEach((i, n) => {
    const token = parts[i] ?? "";
    if (EMAIL_TOKEN.test(token)) {
      cut.add(i);
      if (token === "@") {
        if (n > 0) cut.add(words[n - 1] as number);
        if (n + 1 < words.length) cut.add(words[n + 1] as number);
      }
    }
    if (isDomain(core(i))) cut.add(i);
    // spelled address: the word before "at", then up to 8 words to a domain,
    // a dot word (and its label) or a "dotcom" word
    if (
      AT_WORD.test(core(i).replace(/^-+|-+$/g, "") || token) &&
      n > 0 &&
      !brandLetters.has(core(i).toLowerCase())
    ) {
      let last = -1;
      for (let k = n + 1; k < Math.min(words.length, n + 10); k += 1) {
        const w = coreAt(k);
        if (DOT_TLD_WORD.test(w) || DOMAIN_LIKE.test(w)) {
          last = k;
          break;
        }
        if (
          DOT_WORD.test(w) ||
          DOT_WORD.test(parts[words[k] as number] ?? "")
        ) {
          last = Math.min(k + 1, words.length - 1);
        }
      }
      let first = n - 1;
      while (first > 0 && coreAt(first) === "") first -= 1;
      // the client's own name is never cut: "At Home Care ... at
      // homecare.com" (r5), "Play2Learn at", "U-Haul at", "O'Brien at",
      // "Route 66 at" (r6). Its digits still go through the digit rule below.
      if (last > n)
        for (let k = first; k <= last; k += 1) {
          const w = coreAt(k);
          const ownName =
            brandLetters.has(w.toLowerCase()) ||
            (k < n && (brandPieces.includes(alnum(w)) || brandToken(w)));
          if (!ownName) cut.add(words[k] as number);
        }
    }
  });
  words.forEach((i, n) => {
    const token = parts[i] ?? "";
    if (cut.has(i)) {
      parts[i] = "[email]";
      return;
    }
    if (!/\d/.test(token)) return;
    const c = core(i);
    if (SAFE_TERMS.has(c.toLowerCase()) || brandToken(c)) return;
    // a numbered start of the brand that the next word completes: "A1
    // Plumbing", "2B Brothers"-style unit numbers do not continue it (r6)
    const own = alnum(c);
    const after = alnum(coreAt(n + 1) ?? "");
    if (/[a-z]/.test(own) && after !== "" && brandFull.startsWith(own + after))
      return;
    // a spaced numbered brand ("5 Star Plumbing", "A 1 Plumbing",
    // "1 800 FLOWERS"): a brand digit is kept only when a word right next to
    // it is the brand's own neighbour of that digit, so "Unit 4" or
    // "2 Rio Drive" near the name is still cut (r5)
    if (brandDigits.has(c)) {
      const prev = alnum(coreAt(n - 1) ?? "");
      const next = alnum(coreAt(n + 1) ?? "");
      const inBrand = brandPieces.some(
        (piece, j) =>
          piece === c &&
          ((j > 0 && prev !== "" && brandPieces[j - 1] === prev) ||
            (j + 1 < brandPieces.length &&
              next !== "" &&
              brandPieces[j + 1] === next)),
      );
      if (inBrand) return;
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
