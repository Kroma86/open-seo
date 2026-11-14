import { z } from "zod";
import { textMentionsBrand } from "@/server/features/ai-search/services/brandMatch";

export type Engine = "chatgpt" | "ai_mode";

const linkSchema = z.object({
  url: z.string().nullish(),
  domain: z.string().nullish(),
});
const entitySchema = z.object({
  title: z.string().nullish(),
  urls: z.array(linkSchema).nullish(),
});
type Item = {
  type: string;
  title?: string | null;
  markdown?: string | null;
  text?: string | null;
  url?: string | null;
  domain?: string | null;
  sources?: z.infer<typeof linkSchema>[] | null;
  references?: z.infer<typeof linkSchema>[] | null;
  brand_entities?: z.infer<typeof entitySchema>[] | null;
  items?: Item[] | null;
  components?: Item[] | null;
};
const itemSchema: z.ZodType<Item> = z.lazy(() =>
  z.object({
    type: z.string(),
    title: z.string().nullish(),
    markdown: z.string().nullish(),
    text: z.string().nullish(),
    url: z.string().nullish(),
    domain: z.string().nullish(),
    sources: z.array(linkSchema).nullish(),
    references: z.array(linkSchema).nullish(),
    brand_entities: z.array(entitySchema).nullish(),
    items: z.array(itemSchema).nullish(),
    components: z.array(itemSchema).nullish(),
  }),
);
const resultSchema = z.object({
  markdown: z.string().nullish(),
  sources: z.array(linkSchema).nullish(),
  brand_entities: z.array(entitySchema).nullish(),
  items: z.array(itemSchema).nullish(),
});

function host(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return /^https?:$/.test(url.protocol)
      ? url.hostname
          .toLowerCase()
          .replace(/^www\./, "")
          .replace(/\.$/, "")
      : null;
  } catch {
    return null;
  }
}

export type Measurement = {
  named: boolean;
  cited: boolean;
  channels: string[];
  citedDomains: string[];
};

export function parseMeasurement(
  engine: Engine,
  raw: unknown,
  brand: string,
  domain: string,
): Measurement | null {
  const parsed = resultSchema.safeParse(raw);
  const target = host(domain);
  if (!parsed.success || !target || !brand.trim()) return null;
  const result = parsed.data;
  const channels = new Set<string>();
  const citedDomains = new Set<string>();
  let hasAnswer = false;
  const matchesHost = (value: string | null | undefined) => {
    const candidate = host(value);
    return (
      candidate !== null &&
      (candidate === target || candidate.endsWith(`.${target}`))
    );
  };
  const matchesLink = (link: z.infer<typeof linkSchema>) =>
    // A supplied URL is authoritative: a conflicting display domain cannot turn it into a client citation.
    matchesHost(link.url || link.domain);
  const textMatches = (text: string) => {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (
      textMentionsBrand(text, brand) ||
      new RegExp(
        `(?<![\\p{L}\\p{N}_-])(?:[a-z0-9-]+\\.)*${escaped}(?![\\p{L}\\p{N}_.-])`,
        "iu",
      ).test(text)
    );
  };
  const answer = (text: string | null | undefined) => {
    if (!text?.trim()) return;
    hasAnswer = true;
    if (textMatches(text)) channels.add("answer_text");
  };
  const entities = (
    values: z.infer<typeof entitySchema>[] | null | undefined,
  ) => {
    for (const entity of values ?? []) {
      if (
        !entity.title?.trim() &&
        !entity.urls?.some((link) => host(link.url || link.domain))
      )
        continue;
      hasAnswer = true;
      if (
        textMentionsBrand(entity.title ?? "", brand) ||
        entity.urls?.some(matchesLink)
      )
        channels.add("entity");
    }
  };
  let cited = false;
  const citations = (
    links: z.infer<typeof linkSchema>[] | null | undefined,
  ) => {
    for (const link of links ?? []) {
      const citedHost = host(link.url || link.domain);
      if (!citedHost) continue;
      citedDomains.add(citedHost);
      if (matchesLink(link)) {
        cited = true;
        channels.add("cited_source");
      }
    }
  };
  const visit = (item: Item) => {
    if (engine === "chatgpt") {
      if (!item.type.startsWith("chat_gpt_")) return;
      answer(item.markdown);
      entities(item.brand_entities);
      citations(item.sources);
      if (item.type === "chat_gpt_local_businesses") {
        for (const business of item.items ?? []) {
          if (business.type !== "chat_gpt_local_businesses_element") continue;
          if (!business.title?.trim() && !host(business.url || business.domain))
            continue;
          hasAnswer = true;
          if (
            textMentionsBrand(business.title ?? "", brand) ||
            matchesLink(business)
          )
            channels.add("local_business");
        }
        return;
      }
    } else {
      if (!item.type.startsWith("ai_overview")) return;
      answer(item.markdown || item.text);
      citations(item.references);
    }
    for (const child of [...(item.items ?? []), ...(item.components ?? [])])
      visit(child);
  };
  if (engine === "chatgpt") {
    answer(result.markdown);
    entities(result.brand_entities);
    citations(result.sources);
  }
  for (const item of result.items ?? []) visit(item);
  if (!hasAnswer) return null;
  return {
    named: channels.size > 0,
    cited,
    channels: [...channels].toSorted(),
    citedDomains: [...citedDomains].toSorted(),
  };
}

export type MeasurementRow = {
  promptId: string;
  engine: Engine;
  status: string;
  named: boolean | null;
  cited: boolean | null;
  citedDomains: string[];
};

export function wilson95(
  x: number,
  n: number,
): { low: number; high: number } | null {
  if (!Number.isInteger(x) || !Number.isInteger(n) || n <= 0 || x < 0 || x > n)
    return null;
  const z2 = 1.96 ** 2;
  const p = x / n;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const radius =
    (1.96 * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
  return {
    low: Math.max(0, center - radius),
    high: Math.min(1, center + radius),
  };
}

export function summarizeMeasurements(rows: MeasurementRow[], engine: Engine) {
  const selected = rows.filter((row) => row.engine === engine);
  const valid = selected.filter(
    (row) =>
      row.status === "completed" && row.named !== null && row.cited !== null,
  );
  const promptIds = [...new Set(valid.map((row) => row.promptId))];
  const questions = promptIds.map((promptId) => {
    const repeats = valid.filter((row) => row.promptId === promptId);
    return {
      promptId,
      named: repeats.filter((row) => row.named).length * 2 > repeats.length,
      cited: repeats.filter((row) => row.cited).length * 2 > repeats.length,
    };
  });
  const x = questions.filter((question) => question.named).length;
  const n = questions.length;
  const domains = new Map<string, number>();
  for (const row of valid)
    for (const domain of new Set(row.citedDomains))
      domains.set(domain, (domains.get(domain) ?? 0) + 1);
  const count = (status: string) =>
    selected.filter((row) => row.status === status).length;
  return {
    engine,
    status: n === 0 ? "not_measured" : n < 8 ? "too_few_answers" : "measured",
    x,
    n,
    citedX: questions.filter((question) => question.cited).length,
    band: n >= 8 ? wilson95(x, n) : null,
    excluded: {
      error: count("error"),
      timeout: count("timeout"),
      unparsed:
        count("unparsed") +
        selected.filter(
          (row) =>
            row.status === "completed" &&
            (row.named === null || row.cited === null),
        ).length,
      pending: selected.filter(
        (row) =>
          !["completed", "error", "timeout", "unparsed"].includes(row.status),
      ).length,
    },
    topDomains: [...domains]
      .map(([domain, answers]) => ({ domain, answers }))
      .toSorted(
        (a, b) => b.answers - a.answers || a.domain.localeCompare(b.domain),
      )
      .slice(0, 10),
    questions,
  };
}
