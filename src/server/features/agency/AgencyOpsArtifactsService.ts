import { AgencyOpsArtifactsRepository } from "@/server/features/agency/repositories/AgencyOpsArtifactsRepository";

// Single source of truth for accepted kinds — the zod schema in
// src/types/schemas/agency-ops.ts derives from this (the drizzle table stores
// kind as plain text, so no migration is needed to add kinds here).
export const KINDS = [
  "alert-cycle",
  "monthly-report",
  "digest",
  "index-watchdog",
  "schema-proposals",
  "citations",
] as const;
const CONTENT_TYPES = ["json", "html", "markdown"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CONTENT_LENGTH = 262_144;
const MAX_DOMAIN_LENGTH = 253;
const MAX_SOURCE_KEY_LENGTH = 300;

export type Kind = (typeof KINDS)[number];
type ContentType = (typeof CONTENT_TYPES)[number];

export type IngestBody = {
  kind: Kind;
  domain: string | null;
  date: string;
  contentType: ContentType;
  content: string;
  sourceKey: string;
};

export type LatestAlertCycleResult =
  | { receivedAt: string; parseError: true }
  | {
      receivedAt: string;
      generatedAt: string | null;
      countsBySeverity: Record<string, number>;
      /** True count of high-tier alerts in the cycle (not capped at 10). */
      highCount: number;
      highAlerts: Array<{ type: string; domain: string | null; message: string }>;
    };

// The box writes snake_case ("counts_by_severity", "generated_at"); tolerate
// camelCase too so a future producer change cannot silently blank the card.
const HIGH_TIER = new Set(["high", "critical"]);

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function validateIngestBody(body: Record<string, unknown>): IngestBody {
  const kind = body.kind;
  if (!KINDS.includes(kind as Kind)) {
    throw new Error("kind_invalid");
  }

  const domainRaw = body.domain;
  let domain: string | null;
  if (domainRaw === null) {
    domain = null;
  } else if (typeof domainRaw === "string") {
    if (domainRaw.length > MAX_DOMAIN_LENGTH) {
      throw new Error("domain_invalid");
    }
    domain = domainRaw;
  } else {
    throw new Error("domain_invalid");
  }

  const date = body.date;
  if (typeof date !== "string" || !DATE_RE.test(date)) {
    throw new Error("date_invalid");
  }

  // The box sends "md" for markdown artifacts; store the canonical spelling.
  const contentTypeRaw = body.contentType === "md" ? "markdown" : body.contentType;
  if (!CONTENT_TYPES.includes(contentTypeRaw as ContentType)) {
    throw new Error("contentType_invalid");
  }

  const content = body.content;
  if (typeof content !== "string") {
    throw new Error("content_invalid");
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error("content_invalid");
  }

  const sourceKey = body.sourceKey;
  if (
    typeof sourceKey !== "string" ||
    sourceKey.length === 0 ||
    sourceKey.length > MAX_SOURCE_KEY_LENGTH
  ) {
    throw new Error("sourceKey_invalid");
  }

  return {
    kind: kind as Kind,
    domain,
    date,
    contentType: contentTypeRaw as ContentType,
    content,
    sourceKey,
  };
}

async function ingest(body: Record<string, unknown>) {
  const validated = validateIngestBody(body);
  return AgencyOpsArtifactsRepository.insertIfNew(validated);
}

async function latestAlertCycle(): Promise<LatestAlertCycleResult | null> {
  const artifact = await AgencyOpsArtifactsRepository.latestByKind("alert-cycle");
  if (!artifact) return null;

  try {
    const parsed: unknown = JSON.parse(artifact.content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { receivedAt: artifact.receivedAt, parseError: true };
    }

    const record = parsed as Record<string, unknown>;
    const countsRaw = record.counts_by_severity ?? record.countsBySeverity;
    const countsBySeverity: Record<string, number> = {};
    if (countsRaw && typeof countsRaw === "object" && !Array.isArray(countsRaw)) {
      for (const [key, value] of Object.entries(
        countsRaw as Record<string, unknown>,
      )) {
        if (typeof value === "number" && Number.isFinite(value)) {
          const normalized = key.toLowerCase();
          // Sum, don't overwrite: "High": 1 + "high": 2 → high: 3.
          countsBySeverity[normalized] =
            (countsBySeverity[normalized] ?? 0) + value;
        }
      }
    }

    const highAlerts: Array<{
      type: string;
      domain: string | null;
      message: string;
    }> = [];
    let highCount = 0;
    const alerts = Array.isArray(record.alerts) ? record.alerts : [];
    for (const entry of alerts) {
      if (!entry || typeof entry !== "object") continue;
      const alert = entry as Record<string, unknown>;
      const severity = asString(alert.severity)?.toLowerCase();
      if (!severity || !HIGH_TIER.has(severity)) continue;
      const type = asString(alert.type);
      const message = asString(alert.message);
      if (!type || !message) continue;
      highCount += 1;
      if (highAlerts.length < 10) {
        // domain is legitimately null for site-wide alerts (e.g. scan errors)
        highAlerts.push({ type, domain: asString(alert.domain), message });
      }
    }

    return {
      receivedAt: artifact.receivedAt,
      generatedAt: asString(record.generated_at ?? record.generatedAt),
      countsBySeverity,
      highCount,
      highAlerts,
    };
  } catch {
    return { receivedAt: artifact.receivedAt, parseError: true };
  }
}

async function listArtifacts(input: { kind?: Kind; limit?: number }) {
  return AgencyOpsArtifactsRepository.list(input);
}

async function getArtifact(id: string) {
  return AgencyOpsArtifactsRepository.getById(id);
}

export const AgencyOpsArtifactsService = {
  ingest,
  latestAlertCycle,
  listArtifacts,
  getArtifact,
};
