import { createFileRoute } from "@tanstack/react-router";
import { SamLoopsPage } from "@/client/features/sam-loops/SamLoopsPage";

export const Route = createFileRoute("/_project/p/$projectId/loops")({
  component: LoopsRoute,
});

function LoopsRoute() {
  const { projectId } = Route.useParams();
  return <SamLoopsPage projectId={projectId} />;
}
