import { z } from "zod";
import { agencyOpsArtifacts } from "@/db/app.schema";

const kindEnum = z.enum(agencyOpsArtifacts.kind.enumValues);

export const listOpsArtifactsSchema = z.object({
  kind: kindEnum.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export const getOpsArtifactSchema = z.object({
  id: z.string().uuid(),
});
