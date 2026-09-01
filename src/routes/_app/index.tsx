import { createFileRoute } from "@tanstack/react-router";
import { AgencyHomePage } from "@/client/features/agency-home/AgencyHomePage";

export const Route = createFileRoute("/_app/")({
  component: AgencyHomePage,
});
