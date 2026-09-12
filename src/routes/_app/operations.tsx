import { createFileRoute } from "@tanstack/react-router";
import { AgencyOpsPage } from "@/client/features/agency-ops/AgencyOpsPage";

export const Route = createFileRoute("/_app/operations")({
  component: AgencyOpsPage,
});
