import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { handleSamBoxClaim } from "@/server/features/sam-loops/services/samBoxClaim";
import { runSamBoxGates, samBoxJson } from "./samBoxAuth";

export async function handlePost(request: Request): Promise<Response> {
  const gates = await runSamBoxGates(request);
  if (!gates.ok) return gates.response;
  return samBoxJson(await handleSamBoxClaim({ env, body: gates.body }));
}

export const Route = createFileRoute("/api/internal/sam-box-claim")({
  server: {
    handlers: {
      POST: ({ request }) => handlePost(request),
    },
  },
});
