import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import type { ProjectSummary } from "@/client/features/projects/types";
import { storeSamAskDraft } from "@/client/features/agency-home/agencyHomeUtils";

export function AgencyHomePromptBar({
  projects,
  initialPrompt = "",
}: {
  projects: ProjectSummary[];
  initialPrompt?: string;
}) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState(initialPrompt);
  const [picking, setPicking] = useState(false);

  const goToSam = (projectId: string, text: string) => {
    storeSamAskDraft(projectId, text);
    setPicking(false);
    void navigate({
      to: "/p/$projectId/sam",
      params: { projectId },
      search: {},
    });
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || projects.length === 0) return;
    if (projects.length === 1) {
      goToSam(projects[0].id, text);
      return;
    }
    setPicking(true);
  };

  return (
    <section className="space-y-3">
      <div className="relative">
        <label className="sr-only" htmlFor="agency-home-ask">
          Ask Sam to do anything
        </label>
        <div className="flex items-stretch gap-2 rounded-2xl border border-base-300/80 bg-base-100 p-2 shadow-sm ring-1 ring-base-content/5 transition focus-within:border-primary/40 focus-within:ring-primary/20">
          <div className="flex items-center pl-2 text-primary/80">
            <Sparkles className="size-5" aria-hidden />
          </div>
          <input
            id="agency-home-ask"
            className="min-w-0 flex-1 bg-transparent px-2 py-2.5 text-base text-base-content outline-none placeholder:text-base-content/40"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (picking) setPicking(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Ask Sam to do anything…"
            autoComplete="off"
          />
          <button
            type="button"
            className="btn btn-primary btn-sm gap-1.5 self-center"
            disabled={!draft.trim() || projects.length === 0}
            onClick={submit}
          >
            Put Sam to work
            <ArrowRight className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>

      {picking && projects.length > 1 ? (
        <div className="rounded-xl border border-base-300/70 bg-base-200/40 p-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-base-content/50">
            Choose a project
          </p>
          <ul className="flex flex-wrap gap-2">
            {projects.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm border border-base-300/60 bg-base-100"
                  onClick={() => goToSam(project.id, draft)}
                >
                  <span className="truncate max-w-[12rem]">
                    {project.domain ?? project.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
