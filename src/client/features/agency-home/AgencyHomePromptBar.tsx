import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import type { ProjectSummary } from "@/client/features/projects/types";
import { storeSamAskDraft } from "@/client/features/agency-home/agencyHomeUtils";
import { AGENCY_WORKFLOW_CHIPS } from "@/client/features/agency-home/workflowChips";

const ROTATE_MS = 4500;
const ROTATING_PROMPTS = AGENCY_WORKFLOW_CHIPS.slice(0, 5).map((chip) => chip.prompt);

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
  const [focused, setFocused] = useState(false);
  const [promptIndex, setPromptIndex] = useState(0);

  const rotatingPrompts = useMemo(() => ROTATING_PROMPTS, []);
  const showRotatingPlaceholder = !draft && !focused && rotatingPrompts.length > 0;
  const activePlaceholder =
    rotatingPrompts[promptIndex % rotatingPrompts.length] ?? "";

  useEffect(() => {
    if (!showRotatingPlaceholder) return;
    const id = window.setInterval(() => {
      setPromptIndex((i) => (i + 1) % rotatingPrompts.length);
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [showRotatingPlaceholder, rotatingPrompts.length]);

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
          <div className="relative min-w-0 flex-1">
            {showRotatingPlaceholder ? (
              <span
                className="pointer-events-none absolute inset-x-2 inset-y-0 flex items-center truncate text-base text-base-content/40"
                aria-hidden
              >
                {activePlaceholder}
              </span>
            ) : null}
            <input
              id="agency-home-ask"
              className="w-full bg-transparent px-2 py-2.5 text-base text-base-content outline-none"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (picking) setPicking(false);
              }}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={
                showRotatingPlaceholder ? "" : "Ask Sam to do anything…"
              }
              autoComplete="off"
              aria-label={
                showRotatingPlaceholder
                  ? activePlaceholder
                  : "Ask Sam to do anything"
              }
            />
          </div>
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
                  <span className="max-w-[12rem] truncate">
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
