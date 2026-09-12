import { AgencyOpsArtifactsRepository } from "@/server/features/agency/repositories/AgencyOpsArtifactsRepository";

export type MonthlyExportByDomainResult = {
  domain: string;
  month: string;
  sourceKey: string;
  receivedAt: string;
  export: unknown;
};

export type MonthlyExportByDomainInvalidResult = {
  domain: string;
  month: string;
  sourceKey: string;
  receivedAt: string;
  export: null;
  error: "content_invalid";
};

export type MonthlyExportIndexResult = {
  month: string;
  sourceKey: string;
  receivedAt: string;
  index: unknown;
};

export type MonthlyExportIndexInvalidResult = {
  month: string;
  sourceKey: string;
  receivedAt: string;
  index: null;
  error: "content_invalid";
};

type ParseJsonResult =
  | { ok: true; value: unknown }
  | { ok: false };

/** Mirror ingest storage: trim, lower-case, strip trailing dots. Ingest keeps www. */
function normalizeExportDomain(raw: string): string {
  let domain = raw.trim().toLowerCase();
  while (domain.endsWith(".")) {
    domain = domain.slice(0, -1);
  }
  return domain;
}

function parseJsonContent(content: string): ParseJsonResult {
  try {
    return { ok: true, value: JSON.parse(content) };
  } catch {
    return { ok: false };
  }
}

export async function getAgencyMonthlyExportByDomain(
  domain: string,
  month: string,
): Promise<MonthlyExportByDomainResult | MonthlyExportByDomainInvalidResult | null> {
  const normalizedDomain = normalizeExportDomain(domain);
  const artifact = await AgencyOpsArtifactsRepository.latestByKindDomainDate(
    "monthly-export",
    normalizedDomain,
    `${month}-01`,
  );
  if (!artifact) return null;

  const parsed = parseJsonContent(artifact.content);
  if (!parsed.ok) {
    return {
      domain: normalizedDomain,
      month,
      sourceKey: artifact.sourceKey,
      receivedAt: artifact.receivedAt,
      export: null,
      error: "content_invalid",
    };
  }

  return {
    domain: normalizedDomain,
    month,
    sourceKey: artifact.sourceKey,
    receivedAt: artifact.receivedAt,
    export: parsed.value,
  };
}

export async function getAgencyMonthlyExportIndex(
  month: string,
): Promise<MonthlyExportIndexResult | MonthlyExportIndexInvalidResult | null> {
  const artifact = await AgencyOpsArtifactsRepository.latestByKindDomainDate(
    "monthly-export",
    null,
    `${month}-01`,
    "export-index-",
  );
  if (!artifact) return null;

  const parsed = parseJsonContent(artifact.content);
  if (!parsed.ok) {
    return {
      month,
      sourceKey: artifact.sourceKey,
      receivedAt: artifact.receivedAt,
      index: null,
      error: "content_invalid",
    };
  }

  return {
    month,
    sourceKey: artifact.sourceKey,
    receivedAt: artifact.receivedAt,
    index: parsed.value,
  };
}
