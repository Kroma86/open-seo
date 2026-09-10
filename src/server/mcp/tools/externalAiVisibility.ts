import { z } from "zod";

const SOURCE = "Hermes AI visibility" as const;
const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;
const HOSTNAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

const unavailable = (status: "missing" | "invalid", note: string) => ({
  source: SOURCE,
  status,
  measuredAt: null,
  stale: null,
  runStatus: null,
  answers: [] as Array<{
    question: string;
    platform: "chat_gpt";
    model: string;
    text: string;
    citations: string[];
  }>,
  googleScanPresent: false,
  comparisonsSupported: false as const,
  note,
});

const INVALID_NOTE =
  "The Hermes AI visibility data could not be validated, so no answers or Google brand-scan result are shown.";

const citationSchema = z.string().refine((value) => {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0 &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
});

const payloadSchema = z.object({
  source: z.literal("hermes-ai-visibility"),
  domain: z.string(),
  finished_at: z.iso.datetime({ offset: true }),
  status: z.enum(["completed", "partial"]),
  answers: z
    .array(
      z.object({
        question: z
          .string()
          .max(500)
          .refine((s) => s.trim().length > 0)
          .transform((s) => s.trim()),
        platform: z.literal("chat_gpt"),
        model: z
          .string()
          .max(100)
          .refine((s) => s.trim().length > 0)
          .transform((s) => s.trim()),
        text: z
          .string()
          .max(20000)
          .refine((s) => s.trim().length > 0),
        citations: z.array(citationSchema).max(50),
      }),
    )
    .max(30),
  google_scan_present: z.boolean(),
});

function normalizeHostname(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 253 || /[\s:/?#@\\[\]]/.test(trimmed))
    return null;
  if (!HOSTNAME.test(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  const stripped = lower.startsWith("www.") ? lower.slice(4) : lower;
  return HOSTNAME.test(stripped) ? stripped : null;
}

export function parseExternalAiVisibility(
  input: unknown,
  expectedDomain: string,
  now: Date,
) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return unavailable("invalid", INVALID_NOTE);
  }
  const expected = normalizeHostname(expectedDomain);
  if (!expected) return unavailable("invalid", INVALID_NOTE);
  if (input === undefined || input === null) {
    return unavailable(
      "missing",
      "No Hermes AI visibility data was provided. Captured answers and Google brand-scan results are unavailable from this feed.",
    );
  }
  const parsed = payloadSchema.safeParse(input);
  if (!parsed.success) return unavailable("invalid", INVALID_NOTE);
  const payload = parsed.data;
  const actual = normalizeHostname(payload.domain);
  if (!actual || actual !== expected)
    return unavailable("invalid", INVALID_NOTE);
  const measured = new Date(payload.finished_at);
  if (Number.isNaN(measured.getTime()) || measured.getTime() > now.getTime()) {
    return unavailable("invalid", INVALID_NOTE);
  }
  if (payload.answers.length === 0 && payload.google_scan_present === false) {
    return unavailable("invalid", INVALID_NOTE);
  }
  const n = payload.answers.length;
  return {
    source: SOURCE,
    status: "available" as const,
    measuredAt: measured.toISOString(),
    stale: now.getTime() - measured.getTime() > EIGHT_DAYS_MS,
    runStatus: payload.status,
    answers: payload.answers.map((a) => ({
      question: a.question,
      platform: "chat_gpt" as const,
      model: a.model,
      text: a.text,
      citations: [...a.citations],
    })),
    googleScanPresent: payload.google_scan_present,
    comparisonsSupported: false as const,
    note: `Captured ${n} ChatGPT answer${n === 1 ? "" : "s"}. Google brand scan is ${payload.google_scan_present ? "present" : "not present"} as a separate summary. These observations do not establish trends or coverage of other platforms.`,
  };
}
