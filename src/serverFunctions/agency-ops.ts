import { createServerFn } from "@tanstack/react-start";
import { AgencyOpsArtifactsService } from "@/server/features/agency/AgencyOpsArtifactsService";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";
import {
  getOpsArtifactSchema,
  listOpsArtifactsSchema,
} from "@/types/schemas/agency-ops";

export const getLatestAlertCycle = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .handler(async () => {
    // Box-wide artifacts, not org-scoped — this install is single-agency selfhost.
    return AgencyOpsArtifactsService.latestAlertCycle();
  });

export const listOpsArtifacts = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(listOpsArtifactsSchema)
  .handler(async ({ data }) => {
    // Box-wide artifacts, not org-scoped — this install is single-agency selfhost.
    return AgencyOpsArtifactsService.listArtifacts(data);
  });

export const getOpsArtifact = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(getOpsArtifactSchema)
  .handler(async ({ data }) => {
    // Box-wide artifacts, not org-scoped — this install is single-agency selfhost.
    return AgencyOpsArtifactsService.getArtifact(data.id);
  });
