/**
 * Brand mention matching for AI-visibility scoring.
 *
 * Why this is not a literal substring match: the models rewrite punctuation in
 * the names they quote. A real capture on 19 Sep 2026 had Perplexity rank a
 * client FIRST for its core local query while our board scored the project
 * 0/10 — the answer said `B‑Line Electrical Services` with a NON-BREAKING
 * HYPHEN, and the registered brand used an ASCII hyphen, so the literal match
 * missed it. Models also drop registered commas ("Greenaway, Theis" ->
 * "Greenaway Theis"), emit curly apostrophes, and use non-breaking spaces.
 *
 * So we match on the brand's word tokens, allowing any short run of
 * non-alphanumeric characters between them, and guard both ends against
 * alphanumerics so a brand cannot match inside a longer word.
 */

const ALNUM = "\\p{L}\\p{N}";
/** Longest run of separator characters tolerated between two brand tokens. */
const MAX_SEPARATOR = 4;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word tokens of a brand, ignoring punctuation, spacing and dash flavour. */
function brandTokens(brand: string): string[] {
  return brand.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Regex matching `brand` tolerantly. Never matches when the brand carries no
 * alphanumeric content, rather than matching everything.
 */
export function brandMentionRegex(brand: string): RegExp | null {
  const tokens = brandTokens(brand);
  if (tokens.length === 0) return null;
  const separator = `[^${ALNUM}]{0,${MAX_SEPARATOR}}`;
  const body = tokens.map(escapeRegExp).join(separator);
  return new RegExp(`(?<![${ALNUM}])${body}(?![${ALNUM}])`, "iu");
}

export function textMentionsBrand(
  text: string,
  brand: string | null,
): boolean {
  if (!brand) return false;
  const pattern = brandMentionRegex(brand);
  if (!pattern) return false;
  return pattern.test(text.normalize("NFKC"));
}

/**
 * A citation counts as the brand's when the brand appears in its title, or
 * when the brand's tokens run together in the hostname (`blineelectric.ca`
 * for "B-Line Electric"). Kept separate from text matching because URLs have
 * no spaces to tolerate.
 */
export function citationMatchesBrand(
  url: string,
  title: string | null | undefined,
  brand: string | null,
): boolean {
  if (!brand) return false;
  if (textMentionsBrand(`${title ?? ""}`, brand)) return true;

  const tokens = brandTokens(brand);
  if (tokens.length === 0) return false;
  const host = url.toLowerCase().replace(/[^a-z0-9]/g, "");
  const joined = tokens.join("").toLowerCase();
  return joined.length >= 6 && host.includes(joined);
}
