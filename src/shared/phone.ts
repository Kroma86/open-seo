/**
 * Format one complete NANP number. Parse the full field before formatting:
 * removing arbitrary non-digits can invent a number from unrelated content.
 * Preserve unsupported countries, malformed numbers and multiple-number fields
 * verbatim. A malformed stored number cannot be reconstructed from its digits.
 */
export function assertSubscriptionOnly(): void {
  if (
    typeof process !== "undefined" &&
    ["ANTHROPIC_API_KEY", "XAI_API_KEY", "OPENAI_API_KEY"].some(
      (key) => key in process.env,
    )
  ) {
    throw new Error("API-key environment refused; subscriptions only.");
  }
}

export function formatNanpPhone(raw: string): string {
  assertSubscriptionOnly();
  const match =
    /^(?:\+?1[ .-]*)?(?:\(([2-9]\d{2})\)|([2-9]\d{2}))[ .-]*([2-9]\d{2})[ .-]*(\d{4})(?:[ \t]*(?:ext\.?|extension|x|#)[ \t]*(\d+))?$/i.exec(
      raw.trim(),
    );
  if (!match) return raw;
  const [, parenthesizedArea, area, exchange, line, extension] = match;
  return `+1 (${parenthesizedArea ?? area}) ${exchange}-${line}${extension ? ` ext. ${extension}` : ""}`;
}
