/**
 * Own-site citations from answers OpenSEO already stored.
 *
 * A "mention" total from the DataForSEO word index counts loose word matches
 * on unrelated pages. The honest number is how many checked answers linked
 * to this project's own site. Those links are already on each saved answer.
 */

export type CitationRef = {
  domain?: string | null;
  url?: string | null;
};

export type AnswerForCitations = {
  status?: string | null;
  citations?: CitationRef[] | null;
};

export type PromptAnswers = {
  results?: AnswerForCitations[] | null;
};

export type OwnSiteCitationSummary = {
  /** Checked answers that linked to the project's own site. Null when none could be checked. */
  ownSiteCitationCount: number | null;
  /** Share of checked answers that linked to the project's own site, 0–100, one decimal. */
  ownSiteCitationSharePct: number | null;
  /** Answers we could inspect. Null when none succeeded. */
  ownSiteCitationsChecked: number | null;
};

const NOT_MEASURED: OwnSiteCitationSummary = {
  ownSiteCitationCount: null,
  ownSiteCitationSharePct: null,
  ownSiteCitationsChecked: null,
};

/** Hostname only: strip scheme, path, port, and a leading www. */
export function normalizeCitationHost(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  let host = raw.trim().toLowerCase();
  if (!host) return null;
  if (host.startsWith("https://")) host = host.slice("https://".length);
  else if (host.startsWith("http://")) host = host.slice("http://".length);
  host = host.split(/[/?#]/)[0] ?? "";
  const at = host.lastIndexOf("@");
  if (at !== -1) host = host.slice(at + 1);
  const colon = host.indexOf(":");
  if (colon !== -1) host = host.slice(0, colon);
  if (host.startsWith("www.")) host = host.slice("www.".length);
  if (!host || host.includes(" ") || !host.includes(".")) return null;
  return host;
}

export function citationHost(citation: CitationRef): string | null {
  return (
    normalizeCitationHost(citation.domain) ??
    normalizeCitationHost(citation.url)
  );
}

/** The site itself or a subdomain. A lookalike host does not count. */
export function hostIsOwnSite(
  host: string | null,
  ownSite: string | null,
): boolean {
  if (!host || !ownSite) return false;
  return host === ownSite || host.endsWith(`.${ownSite}`);
}

function sharePct(count: number, checked: number): number {
  return Math.round((1000 * count) / checked) / 10;
}

export function summarizeOwnSiteCitations(
  prompts: PromptAnswers[] | null | undefined,
  ownSiteRaw: string | null | undefined,
): OwnSiteCitationSummary {
  const ownSite = normalizeCitationHost(ownSiteRaw);
  if (!ownSite || !prompts) return NOT_MEASURED;

  let checked = 0;
  let cited = 0;
  for (const prompt of prompts) {
    const successes = (prompt.results ?? []).filter(
      (row) => row?.status === "success",
    );
    if (successes.length === 0) continue;
    checked += 1;
    const citesOwnSite = successes.some((row) =>
      (row.citations ?? []).some((citation) =>
        hostIsOwnSite(citationHost(citation), ownSite),
      ),
    );
    if (citesOwnSite) cited += 1;
  }

  if (checked === 0) return NOT_MEASURED;
  return {
    ownSiteCitationCount: cited,
    ownSiteCitationSharePct: sharePct(cited, checked),
    ownSiteCitationsChecked: checked,
  };
}

/** Pull saved prompt answers out of a run detail blob. Missing shape stays unmeasured. */
export function parseStoredPromptAnswers(
  detail: string | null | undefined,
): PromptAnswers[] | null {
  if (!detail) return null;
  try {
    const parsed: unknown = JSON.parse(detail);
    if (!parsed || typeof parsed !== "object" || !("prompts" in parsed)) {
      return null;
    }
    const prompts = (parsed as { prompts?: unknown }).prompts;
    if (!Array.isArray(prompts)) return null;
    return prompts.filter(
      (row): row is PromptAnswers => !!row && typeof row === "object",
    );
  } catch {
    return null;
  }
}

export function formatOwnSiteCitations(input: OwnSiteCitationSummary): string {
  if (
    input.ownSiteCitationCount == null ||
    input.ownSiteCitationsChecked == null ||
    input.ownSiteCitationSharePct == null
  ) {
    return "not measured";
  }
  return `${input.ownSiteCitationCount} of ${input.ownSiteCitationsChecked} (${input.ownSiteCitationSharePct}%)`;
}
