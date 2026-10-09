import { z } from "zod";

export const monthlyContentSchema = z.object({
  outcome: z.enum(["draft", "blocked"]),
  reason: z.string(),
  targetKeyword: z.string(),
  title: z.string(),
  body: z.string(),
  sources: z.array(z.object({ url: z.string(), excerpt: z.string() })),
});

export const MONTHLY_CONTENT_INSTRUCTION = `Produce one complete article draft using saved first-party research. Use list_saved_keywords, get_rank_tracker with a trackerId, or get_search_console_performance with a query dimension to choose a target. A saved/tracked keyword is a topic signal, not proof of search volume or ranking. If Search Console is disconnected, try the other saved sources.
Read the site's relevant pages with read_pages. Use only facts supported by readable own-site pages. Inspect existing pages to avoid repeating an existing article. Do not claim a current search-results gap or competitor coverage; that research was not performed. Do not request paid research, publish, write project context, or queue changes.
Return the structured result. For outcome=draft, supply the exact saved targetKeyword, title, a complete article body of at least 600 words with developed prose and headings, and at least one source URL with an exact supporting excerpt from the retrieved page text. Avoid invented prices, guarantees, credentials, locations or testimonials. This is a source-grounded DRAFT for editorial review, not published content. Set reason to an empty string.
If demand or source evidence is unavailable, or you cannot finish the article, set outcome=blocked, explain the specific reason, and leave body empty. Never substitute a plan or outline for an article.`;

const MARKER = /\n?<!-- openseo-monthly-draft-v1:([a-f0-9]{64}) -->\s*$/;
const ALL_MARKERS = /<!--\s*openseo-monthly-draft[^>]*-->/g;

type Step = { toolResults?: Array<{ toolName: string; output?: unknown }> };
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
function ownUrl(value: string, domain: string): string | null {
  try {
    const url = new URL(value);
    const expected = new URL(
      domain.includes("://") ? domain : `https://${domain}`,
    ).hostname
      .replace(/^www\./, "")
      .toLowerCase();
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hostname.replace(/^www\./, "").toLowerCase() !== expected
    )
      return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}
async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export function stripDraftEvidence(report: string): string {
  return report.replace(ALL_MARKERS, "").trim();
}
export async function hasVerifiedMonthlyDraft(
  report: string | null,
): Promise<boolean> {
  if (!report) return false;
  const marker = report.match(MARKER);
  if (!marker) return false;
  const article = report.slice(0, marker.index).trim();
  return (
    article.startsWith(
      "DRAFT — source-grounded article for editorial review. Not published.\n",
    ) && (await hash(article)) === marker[1]
  );
}

type SourcePages = Map<string, string[]>;

function fail(reason: string) {
  return {
    report: `Monthly article not completed: ${reason}`,
    error: reason,
  };
}

function addKeywords(demand: Set<string>, keywordRows: unknown): void {
  for (const row of rows(keywordRows))
    if (typeof row.keyword === "string") demand.add(normalized(row.keyword));
}

function addSearchConsoleQueries(
  demand: Set<string>,
  data: Record<string, unknown>,
): void {
  const dimensions = Array.isArray(data.dimensions) ? data.dimensions : [];
  const index = dimensions.indexOf("query");
  if (index < 0) return;
  for (const row of rows(data.rows)) {
    const term: unknown = Array.isArray(row.keys) ? row.keys[index] : null;
    if (typeof term === "string") demand.add(normalized(term));
  }
}

function addPageSnapshots(
  pages: SourcePages,
  pageRows: unknown,
  domain: string,
): void {
  for (const page of rows(pageRows)) {
    const url = typeof page.url === "string" ? ownUrl(page.url, domain) : null;
    if (url && typeof page.text === "string" && page.text.trim().length >= 80) {
      const snapshots = pages.get(url) ?? [];
      snapshots.push(page.text);
      pages.set(url, snapshots);
    }
  }
}

function collectRunEvidence(
  steps: Step[],
  domain: string,
): { demand: Set<string>; pages: SourcePages } {
  const demand = new Set<string>();
  const pages: SourcePages = new Map();
  for (const step of steps) {
    for (const result of step.toolResults ?? []) {
      const out = record(result.output);
      if (out.error || out.isError === true) continue;
      const data = record(out.data);
      if (result.toolName === "list_saved_keywords") {
        addKeywords(demand, data.rows);
      } else if (result.toolName === "get_rank_tracker") {
        addKeywords(demand, record(data.results).rows);
      } else if (
        result.toolName === "get_search_console_performance" &&
        data.ok === true
      ) {
        addSearchConsoleQueries(demand, data);
      } else if (result.toolName === "read_pages" && out.blocked === false) {
        addPageSnapshots(pages, out.pages, domain);
      }
    }
  }
  return { demand, pages };
}

function verifySource(
  source: { url: string; excerpt: string },
  pages: SourcePages,
  domain: string,
): { url: string } | { failure: string } {
  const url = ownUrl(source.url, domain);
  if (!url)
    return {
      failure:
        "A supporting source URL is invalid or does not belong to this site.",
    };
  const snapshots = pages.get(url);
  if (!snapshots)
    return { failure: "A supporting source URL was not read during this run." };
  const excerpt = source.excerpt.trim().replace(/\s+/g, " ");
  if (excerpt.length < 30)
    return {
      failure: "A supporting source excerpt is shorter than 30 characters.",
    };
  if (!snapshots.some((page) => page.replace(/\s+/g, " ").includes(excerpt)))
    return {
      failure:
        "A supporting source excerpt was not found in any page snapshot read during this run.",
    };
  return { url };
}

export async function validateMonthlyContent(
  output: unknown,
  steps: Step[],
  domain: string,
): Promise<{ report: string; error: string | null }> {
  const parsed = monthlyContentSchema.safeParse(output);
  if (!parsed.success)
    return fail("The run did not return a complete structured article result.");
  const draft = parsed.data;
  if (draft.outcome === "blocked")
    return fail(
      stripDraftEvidence(draft.reason).slice(0, 1000) ||
        "Required research or article content was unavailable.",
    );
  const { demand, pages } = collectRunEvidence(steps, domain);
  if (
    !draft.targetKeyword.trim() ||
    !demand.has(normalized(draft.targetKeyword))
  )
    return fail(
      "The selected topic was not found in saved keywords, tracked terms or measured Search Console queries from this run.",
    );
  const title = stripDraftEvidence(draft.title).trim();
  const body = stripDraftEvidence(draft.body).trim();
  const paragraphs = body
    .split(/\n\s*\n/)
    .filter(
      (p) =>
        !/^\s*(#|[-*]|\d+\.)/.test(p) && p.trim().split(/\s+/).length >= 35,
    );
  if (
    title.length < 8 ||
    body.split(/\s+/).length < 600 ||
    paragraphs.length < 4
  )
    return fail(
      "The article is missing a title or developed prose; an outline is not a completed draft.",
    );
  if (!draft.sources.length)
    return fail("No supporting source pages were supplied.");
  const sources: string[] = [];
  for (const source of draft.sources) {
    const verified = verifySource(source, pages, domain);
    if ("failure" in verified) return fail(verified.failure);
    sources.push(verified.url);
  }
  const report = [
    "DRAFT — source-grounded article for editorial review. Not published.",
    `Target topic: ${stripDraftEvidence(draft.targetKeyword)}`,
    `# ${title}`,
    body,
    "Sources read during this run:\n" +
      [...new Set(sources)].map((url) => `- ${url}`).join("\n"),
    "Evidence limits: the source pages and saved topic were checked. Current competitor coverage and search-results gaps were not measured. Editorial review is still required.",
  ].join("\n\n");
  return {
    report: `${report}\n<!-- openseo-monthly-draft-v1:${await hash(report)} -->`,
    error: null,
  };
}
