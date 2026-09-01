import { z } from "zod";
import { KINDS } from "@/server/features/agency/AgencyOpsArtifactsService";

// The drizzle table stores kind as plain text; KINDS in the service is the
// single source of truth so new kinds need no schema/migration change.
const kindEnum = z.enum(KINDS);

export const listOpsArtifactsSchema = z.object({
  kind: kindEnum.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export const getOpsArtifactSchema = z.object({
  id: z.string().uuid(),
});
