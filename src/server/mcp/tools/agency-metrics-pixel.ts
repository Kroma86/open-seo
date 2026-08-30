export function normalizeOpsDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0];
}

export type AgencyPixelSlice = {
  status: string | null;
  events_7d: number | null;
  as_of: string | null;
  niceseo_pixel_status: string | null;
  found: boolean;
};

/** Pure helper — pick pixel fields for a domain from agency-metrics JSON. */
export function pickPixelFromAgencyMetrics(
  payload: unknown,
  domain: string,
): AgencyPixelSlice {
  const want = normalizeOpsDomain(domain);
  const empty: AgencyPixelSlice = {
    status: null,
    events_7d: null,
    as_of: null,
    niceseo_pixel_status: null,
    found: false,
  };
  if (!payload || typeof payload !== "object") return empty;
  const clients = (payload as { clients?: unknown }).clients;
  if (!Array.isArray(clients)) return empty;
  for (const row of clients) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const host = normalizeOpsDomain(String(r.domain ?? r.host ?? ""));
    if (!host || host !== want) continue;
    const pixel =
      r.pixel && typeof r.pixel === "object"
        ? (r.pixel as Record<string, unknown>)
        : null;
    const status =
      (pixel && typeof pixel.status === "string" ? pixel.status : null) ??
      (typeof r.niceseo_pixel_status === "string"
        ? r.niceseo_pixel_status
        : null) ??
      (typeof r.pixel_status === "string" ? r.pixel_status : null);
    let events: number | null = null;
    if (pixel && typeof pixel.events_7d === "number") {
      events = pixel.events_7d;
    } else if (typeof r.events_7d === "number") {
      events = r.events_7d;
    }
    const asOf =
      (pixel && typeof pixel.as_of === "string" ? pixel.as_of : null) ??
      (typeof r.as_of === "string" ? r.as_of : null);
    return {
      status,
      events_7d: events,
      as_of: asOf,
      niceseo_pixel_status:
        typeof r.niceseo_pixel_status === "string"
          ? r.niceseo_pixel_status
          : null,
      found: true,
    };
  }
  return empty;
}

export async function fetchAgencyPixelStatus(
  domain: string,
  options?: {
    metricsUrl?: string;
    token?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<{
  configured: boolean;
  error: string | null;
  pixel: AgencyPixelSlice;
}> {
  const metricsUrl = options?.metricsUrl;
  const token = options?.token;
  if (!metricsUrl || !token) {
    return {
      configured: false,
      error:
        "pixel status not configured — set AGENCY_METRICS_URL and AGENCY_DASH_TOKEN on this deployment",
      pixel: {
        status: null,
        events_7d: null,
        as_of: null,
        niceseo_pixel_status: null,
        found: false,
      },
    };
  }

  const url = new URL(metricsUrl);
  if (!url.searchParams.has("t")) {
    url.searchParams.set("t", token);
  }
  const fetchImpl = options?.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        // Cloudflare WAF 1010 rejects empty/missing UA from some runtimes.
        "User-Agent": "OpenSEO-SAM/1.0 (+niceseo-ops-status)",
      },
    });
    if (!res.ok) {
      return {
        configured: true,
        error: `agency-metrics HTTP ${res.status}`,
        pixel: {
          status: null,
          events_7d: null,
          as_of: null,
          niceseo_pixel_status: null,
          found: false,
        },
      };
    }
    const payload: unknown = await res.json();
    return {
      configured: true,
      error: null,
      pixel: pickPixelFromAgencyMetrics(payload, domain),
    };
  } catch (err) {
    return {
      configured: true,
      error: err instanceof Error ? err.message : String(err),
      pixel: {
        status: null,
        events_7d: null,
        as_of: null,
        niceseo_pixel_status: null,
        found: false,
      },
    };
  }
}
