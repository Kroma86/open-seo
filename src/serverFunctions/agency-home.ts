import { createServerFn } from "@tanstack/react-start";
import { AgencyHomeService } from "@/server/features/agency/AgencyHomeService";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";

/** Recent Sam loop runs across every project in the caller's org. */
export const getAgencyHomeMissions = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .handler(async ({ context }) =>
    AgencyHomeService.getAgencyHomeMissions(context.organizationId),
  );

/** Portfolio rows for every active project in the caller's org. */
export const getAgencyHomePortfolio = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .handler(async ({ context }) =>
    AgencyHomeService.getAgencyHomePortfolio(context.organizationId),
  );
