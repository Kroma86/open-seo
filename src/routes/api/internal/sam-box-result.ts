import { createFileRoute } from "@tanstack/react-router";
import { handleSamBoxResult } from "@/server/features/sam-loops/services/samBoxResult";
import { runSamBoxGates, samBoxJson } from "./samBoxAuth";

export async function handlePost(request: Request): Promise<Response> {
  const gates = await runSamBoxGates(request);
  if (!gates.ok) return gates.response;
  return samBoxJson(await handleSamBoxResult({ body: gates.body }));
}

export const Route = createFileRoute("/api/internal/sam-box-result")({
  server: {
    handlers: {
      POST: ({ request }) => handlePost(request),
    },
  },
});
