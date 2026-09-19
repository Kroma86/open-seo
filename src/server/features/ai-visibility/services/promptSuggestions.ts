/**
 * Builds the tracked-prompt set for AI visibility.
 *
 * Written after the 19 Sep 2026 audit found the shipped prompts were measuring
 * the wrong thing. They said "Woodstock" with no province: ChatGPT replied
 * "Do you mean Woodstock in which state/country?" and Perplexity answered about
 * Woodstock, GEORGIA. A second client, a mortgage broker in Vernon BC, had two
 * prompts asking about ALBERTA. The sets were also slot-filled from a retail
 * template ("open on weekends", "worth the drive", "typical prices at").
 *
 * So the rules here are deliberate:
 *   - every prompt carries city AND region, because the model disambiguates on it
 *   - the noun comes from the Google Business Profile category ("electricians"),
 *     which is what a customer types, not the niche phrase ("electrical services")
 *   - no region is ever emitted that the caller did not supply
 *   - service prompts come from the services the business actually sells
 */

/** Tracked prompts are capped at 10 active per config. */
export const MAX_TRACKED_PROMPTS = 10;

const CA_REGIONS: Record<string, string> = {
  AB: "Alberta",
  BC: "British Columbia",
  MB: "Manitoba",
  NB: "New Brunswick",
  NL: "Newfoundland and Labrador",
  NS: "Nova Scotia",
  NT: "Northwest Territories",
  NU: "Nunavut",
  ON: "Ontario",
  PE: "Prince Edward Island",
  QC: "Quebec",
  SK: "Saskatchewan",
  YT: "Yukon",
};

export type BusinessLocation = {
  city: string;
  region: string;
  country: string;
};

/**
 * Parses the `Location: City, RR, CC` line stored in project context.
 * Returns null when no region is present — callers must not guess one, since
 * guessing is what put a BC broker's prompts in Alberta.
 */
export function parseBusinessLocation(value: string): BusinessLocation | null {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const [city, rawRegion, rawCountry] = parts;
  if (!city || !rawRegion) return null;

  const region = CA_REGIONS[rawRegion.toUpperCase()] ?? rawRegion;
  return { city, region, country: (rawCountry ?? "CA").toUpperCase() };
}

/**
 * "an electrician", "a mortgage broker". Uses the leading letter, which is
 * right for every Google Business Profile category we carry; a word like
 * "hour" would need a sound-based rule, and none of ours start that way.
 */
export function indefiniteArticle(noun: string): "a" | "an" {
  return /^[aeiou]/i.test(noun.trim()) ? "an" : "a";
}

/**
 * Prepends the article that agrees with the phrase's FIRST word. In
 * "reliable electrician" that is the adjective, not the category noun —
 * taking the article from the category produced "an reliable electrician".
 * Always build the article and the phrase together so they cannot drift.
 */
export function withArticle(phrase: string): string {
  const clean = phrase.trim();
  return `${indefiniteArticle(clean)} ${clean}`;
}

/** "Electrician" -> "electricians". The word a customer actually types. */
export function pluralizeCategory(category: string): string {
  const lower = category.trim().toLowerCase();
  if (!lower) return lower;
  if (/(?:s|x|z|ch|sh)$/.test(lower)) return `${lower}es`;
  if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
  return `${lower}s`;
}

/**
 * How a customer gets to this business, which decides the verb in the prompt.
 * "hire" — an electrician, a landscaper, a law firm.
 * "choose" — one you pick, visit or buy from: a bakery, a bowling club, a
 * furniture store, and also a counsellor or psychologist, whom nobody speaks
 * of hiring. "What should I look for when hiring a pizza restaurant?" is
 * nonsense, and no caller can infer this from the category string reliably,
 * so it is supplied, not guessed.
 */
export type BusinessKind = "hire" | "choose";

export type PromptSuggestionInput = {
  /** Google Business Profile primary category, e.g. "Electrician". */
  category: string;
  city: string;
  region: string;
  /** Defaults to "hire". */
  kind?: BusinessKind;
  /** Services the business actually sells, most distinctive first. */
  services?: string[];
  /**
   * How many prompts this set may use, never above MAX_TRACKED_PROMPTS.
   * A client with two locations calls this once per location and splits the
   * cap between them.
   */
  limit?: number;
};

export function buildAiVisibilityPrompts(
  input: PromptSuggestionInput,
): string[] {
  const city = input.city.trim();
  const region = input.region.trim();
  if (!region) {
    throw new Error(
      "A region is required: without it the models answer about a same-named city elsewhere.",
    );
  }
  if (!city) throw new Error("A city is required.");

  const where = `${city}, ${region}`;
  const plural = pluralizeCategory(input.category);
  const singular = input.category.trim().toLowerCase();

  // Every line here has to make sense for ANY local category. An earlier draft
  // asked "which ... offer emergency service?", which is fine for an
  // electrician and nonsense for a mortgage broker — the same category
  // mismatch that put "open on weekends" in the shipped set.
  const choose = (input.kind ?? "hire") === "choose";

  // Order matters, because a client with two locations splits one 10-prompt
  // cap between them. The lines that make a model NAME businesses come first;
  // the advice line goes last, so a cap takes it before anything we measure
  // with. Services sit ahead of it for the same reason.
  const prompts: string[] = [
    `Who are the best ${plural} in ${where}?`,
    `Which ${plural} in ${where} have the best reviews?`,
    `Who are the top-rated ${plural} near ${where}?`,
    choose
      ? `Can you recommend ${withArticle(`good ${singular}`)} in ${where}?`
      : `Can you recommend ${withArticle(`reliable ${singular}`)} in ${where}?`,
    choose
      ? `Which ${singular} do locals in ${where} recommend?`
      : `Who do locals use for ${withArticle(singular)} in ${where}?`,
  ];

  for (const service of input.services ?? []) {
    const clean = service.trim();
    if (clean) prompts.push(`Who offers ${clean} in ${where}?`);
  }

  prompts.push(
    choose
      ? `What makes ${withArticle(`good ${singular}`)} in ${where}?`
      : `What should I look for when hiring ${withArticle(singular)} in ${where}?`,
  );

  const seen = new Set<string>();
  const unique = prompts.filter((prompt) => {
    const key = prompt.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const limit = Math.min(input.limit ?? MAX_TRACKED_PROMPTS, MAX_TRACKED_PROMPTS);
  if (limit < 1) throw new Error("A prompt set needs at least one prompt.");

  return unique.slice(0, limit);
}
