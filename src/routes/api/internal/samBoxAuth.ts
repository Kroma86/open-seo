import { env } from "cloudflare:workers";
import { getSamBoxMode } from "@/server/features/sam-loops/services/samBoxMode";
import type { SamBoxHttpResult } from "@/server/features/sam-loops/services/samBoxTypes";

export const NO_STORE = { "cache-control": "no-store" } as const;

export function samBoxJson(result: SamBoxHttpResult): Response {
  return Response.json(result.body, {
    status: result.status,
    headers: NO_STORE,
  });
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function extractBearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export async function runSamBoxGates(
  request: Request,
): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  const expected = env.SAM_LOOP_BOX_TOKEN?.trim();
  if (!expected) {
    return {
      ok: false,
      response: samBoxJson({
        status: 503,
        body: { error: "sam_box_disabled" },
      }),
    };
  }
  const token = extractBearer(request);
  if (!token || !timingSafeEqual(token, expected)) {
    return {
      ok: false,
      response: samBoxJson({ status: 401, body: { error: "unauthorized" } }),
    };
  }
  if (getSamBoxMode(env) !== "on") {
    return {
      ok: false,
      response: samBoxJson({ status: 503, body: { error: "sam_box_off" } }),
    };
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      ok: false,
      response: samBoxJson({ status: 400, body: { error: "invalid_json" } }),
    };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      response: samBoxJson({ status: 400, body: { error: "invalid_body" } }),
    };
  }
  const record = body as Record<string, unknown>;
  if (record.contract !== 1) {
    return {
      ok: false,
      response: samBoxJson({
        status: 400,
        body: { error: "unsupported_contract", supported: [1] },
      }),
    };
  }
  return { ok: true, body: record };
}
