import { createFileRoute } from "@tanstack/react-router";
import { AiVisibilityPage } from "@/client/features/ai-visibility/AiVisibilityPage";

export const Route = createFileRoute("/_project/p/$projectId/ai-visibility")({
  component: AiVisibilityRoute,
});

function AiVisibilityRoute() {
  const { projectId } = Route.useParams();
  return (
    <div className="px-4 py-4 pb-24 overflow-auto md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-5xl">
        <AiVisibilityPage projectId={projectId} />
      </div>
    </div>
  );
}
