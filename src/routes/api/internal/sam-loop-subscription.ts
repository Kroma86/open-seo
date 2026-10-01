import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { withPgClient } from "@/db";
import { subscriptionRequestSchema } from "@/server/features/sam-loops/services/subscriptionContract";
import {
  getSubscriptionLoopRequest,
  postSubscriptionLoopRequest,
  SubscriptionLoopError,
} from "@/server/features/sam-loops/services/subscriptionSamLoops";

function authenticate(request: Request): Response | null {
  const expected = (
    env as { AGENCY_SCORE_EXPORT_TOKEN?: string }
  ).AGENCY_SCORE_EXPORT_TOKEN?.trim();
  if (!expected)
    return Response.json({ error: "subscription_disabled" }, { status: 503 });
  const actual =
    /^Bearer\s+(.+)$/i
      .exec(request.headers.get("authorization") ?? "")?.[1]
      ?.trim() ?? "";
  const left = new TextEncoder().encode(actual);
  const right = new TextEncoder().encode(expected);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0
    ? null
    : Response.json({ error: "unauthorized" }, { status: 401 });
}

async function responseFor(
  operation: () => Promise<unknown>,
): Promise<Response> {
  try {
    return Response.json(await withPgClient(operation), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof SubscriptionLoopError)
      return Response.json(
        { error: error.message },
        { status: error.status, headers: { "cache-control": "no-store" } },
      );
    return Response.json(
      { error: "subscription_request_failed" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function handleGet(request: Request): Promise<Response> {
  const rejected = authenticate(request);
  if (rejected) return rejected;
  return responseFor(() => getSubscriptionLoopRequest(new URL(request.url)));
}

export async function handlePost(request: Request): Promise<Response> {
  const rejected = authenticate(request);
  if (rejected) return rejected;
  if (
    (env as { SAM_LOOP_EXECUTOR?: string }).SAM_LOOP_EXECUTOR !== "subscription"
  )
    return Response.json(
      { error: "subscription_mode_required" },
      { status: 409 },
    );
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return Response.json({ error: "json_required" }, { status: 415 });
  const reader = request.body?.getReader();
  if (!reader)
    return Response.json({ error: "invalid_contract" }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > 1_200_000) {
        await reader.cancel();
        return Response.json({ error: "body_too_large" }, { status: 413 });
      }
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const parsed = subscriptionRequestSchema.safeParse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    if (!parsed.success)
      return Response.json(
        {
          error: "invalid_contract",
          reason: "Request does not match the loop result contract.",
        },
        { status: 400 },
      );
    return responseFor(() => postSubscriptionLoopRequest(parsed.data));
  } catch {
    return Response.json(
      { error: "invalid_contract", reason: "Request is not complete JSON." },
      { status: 400 },
    );
  }
}

export const Route = createFileRoute("/api/internal/sam-loop-subscription")({
  server: {
    handlers: {
      GET: ({ request }) => handleGet(request),
      POST: ({ request }) => handlePost(request),
    },
  },
});
