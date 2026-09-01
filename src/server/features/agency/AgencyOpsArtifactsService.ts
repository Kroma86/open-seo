import { AgencyOpsArtifactsRepository } from "@/server/features/agency/repositories/AgencyOpsArtifactsRepository";

const KINDS = ["alert-cycle", "monthly-report", "digest"] as const;
const CONTENT_TYPES = ["json", "html", "markdown"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CONTENT_LENGTH = 262_144;
const MAX_DOMAIN_LENGTH = 253;
const MAX_SOURCE_KEY_LENGTH = 300;

type Kind = (typeof KINDS)[number];
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
      highAlerts: Array<{ type: string; domain: string; message: string }>;
    };

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

  const contentType = body.contentType;
  if (!CONTENT_TYPES.includes(contentType as ContentType)) {
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
    contentType: contentType as ContentType,
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
    if (!parsed || typeof parsed !== "object") {
      return { receivedAt: artifact.receivedAt, parseError: true };
    }

    const record = parsed as Record<string, unknown>;
    const countsBySeverity: Record<string, number> = {};
    if (record.countsBySeverity && typeof record.countsBySeverity === "object") {
      for (const [key, value] of Object.entries(
        record.countsBySeverity as Record<string, unknown>,
      )) {
        if (typeof value === "number" && Number.isFinite(value)) {
          countsBySeverity[key] = value;
        }
      }
    }

    const highAlerts: Array<{ type: string; domain: string; message: string }> =
      [];
    const alerts = Array.isArray(record.alerts) ? record.alerts : [];
    for (const entry of alerts) {
      if (!entry || typeof entry !== "object") continue;
      const alert = entry as Record<string, unknown>;
      if (alert.severity !== "high") continue;
      const type = asString(alert.type);
      const domain = asString(alert.domain);
      const message = asString(alert.message);
      if (!type || !domain || !message) continue;
      highAlerts.push({ type, domain, message });
      if (highAlerts.length >= 10) break;
    }

    return {
      receivedAt: artifact.receivedAt,
      generatedAt: asString(record.generatedAt),
      countsBySeverity,
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
