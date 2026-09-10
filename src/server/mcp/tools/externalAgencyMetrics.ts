import { getOptionalEnvValue } from "@/server/lib/runtime-env";

const MAX_FEED_BYTES = 8 * 1024 * 1024;

async function readBoundedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_FEED_BYTES || !response.body) {
    await response.body?.cancel();
    throw new Error("Invalid feed size");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_FEED_BYTES) {
        await reader.cancel();
        throw new Error("Feed exceeds size limit");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

function host(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase().replace(/^www\./, "");
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(value) ? value : null;
}

/** Read only the authorized project's row from the existing internal agency feed. */
export async function fetchExternalAgencyMetrics(domain: string | null, options?: {
  metricsUrl?: string; token?: string; fetchImpl?: typeof fetch;
}): Promise<{ rank: unknown; ai: unknown; error: string | null }> {
  const empty = (error: string) => ({ rank: null, ai: null, error });
  const wanted = host(domain);
  if (!wanted) return empty("External observations unavailable: project domain is missing or invalid.");
  const metricsUrl = options?.metricsUrl ?? await getOptionalEnvValue("AGENCY_METRICS_URL");
  const token = options?.token ?? await getOptionalEnvValue("AGENCY_DASH_TOKEN");
  if (!metricsUrl || !token) return empty("External observations unavailable: agency feed is not configured.");
  try {
    const url = new URL(metricsUrl);
    if (url.protocol !== "https:" || url.username || url.password) return empty("External observations unavailable: invalid feed configuration.");
    if (!url.searchParams.has("t")) url.searchParams.set("t", token);
    const response = await (options?.fetchImpl ?? fetch)(url.toString(), {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "OpenSEO-SAM/1.0 (+stored-observations)" },
    });
    if (!response.ok) return empty("External observations unavailable: agency feed request failed.");
    const payload = await readBoundedJson(response);
    if (!payload || typeof payload !== "object" || !("clients" in payload) || !Array.isArray(payload.clients)) return empty("External observations unavailable: invalid agency response.");
    const rows = payload.clients.filter((row: unknown): row is Record<string, unknown> => !!row && typeof row === "object" && "domain" in row && host(row.domain) === wanted);
    if (rows.length !== 1) return empty("External observations unavailable: no unique project row in agency feed.");
    return { rank: rows[0]!.external_rank_observations ?? null, ai: rows[0]!.external_ai_visibility ?? null, error: null };
  } catch {
    return empty("External observations unavailable: agency feed timed out or could not be read.");
  }
}
