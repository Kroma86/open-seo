import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Repeat } from "lucide-react";
import {
  createSamLoop,
  getContentVelocity,
  listSamLoopSkills,
  listSamLoops,
} from "@/serverFunctions/sam-loops";
import { DEFAULT_SAM_LOOP_TEMPLATES } from "@/shared/sam-loops";
import {
  AskSamSection,
  ContentVelocitySection,
  RunsSection,
  type SamLoopRunRow,
} from "./samLoopsDisplay";
import {
  CreateLoopForm,
  LoopsSection,
  useCreateLoopForm,
  useTriggerLoopMutation,
  type SamLoopSkill,
} from "./SamLoopsManage";

const NO_RUNS: SamLoopRunRow[] = [];
const NO_SKILLS: SamLoopSkill[] = [];

/** Read + clear agency-home mission handoff (sessionStorage). */
function takeSelectedRunHandoff(projectId: string): string | null {
  try {
    const key = `sam-loops-select-run:${projectId}`;
    const runId = sessionStorage.getItem(key)?.trim() || null;
    sessionStorage.removeItem(key);
    return runId;
  } catch {
    return null;
  }
}

export function SamLoopsPage({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() =>
    takeSelectedRunHandoff(projectId),
  );
  const reportRef = useRef<HTMLElement>(null);
  const form = useCreateLoopForm();
  const {
    setShowCreate,
    createMode,
    setCreateMode,
    createName,
    setCreateName,
    createSkill,
    setCreateSkill,
    createPrompt,
    setCreatePrompt,
    createCadence,
    setCreateCadence,
  } = form;

  const loopsQuery = useQuery({
    queryKey: ["sam-loops", projectId],
    queryFn: () => listSamLoops({ data: { projectId } }),
  });

  const velocityQuery = useQuery({
    queryKey: ["sam-loops-velocity", projectId],
    queryFn: () => getContentVelocity({ data: { projectId } }),
  });

  const skillsQuery = useQuery({
    queryKey: ["sam-loop-skills", projectId],
    queryFn: () => listSamLoopSkills({ data: { projectId } }),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["sam-loops", projectId] });
    void queryClient.invalidateQueries({
      queryKey: ["sam-loops-velocity", projectId],
    });
  };

  const triggerMutation = useTriggerLoopMutation(projectId, invalidate);

  const createMutation = useMutation({
    mutationFn: () =>
      createSamLoop({
        data: {
          projectId,
          name: createName.trim(),
          sourceType: createMode,
          skillName: createMode === "skill" ? createSkill : undefined,
          customPrompt: createMode === "custom" ? createPrompt : undefined,
          cadence: createCadence,
        },
      }),
    onSuccess: () => {
      setShowCreate(false);
      setCreateName("");
      setCreatePrompt("");
      invalidate();
    },
  });

  const loops = loopsQuery.data?.loops ?? [];
  const runs = loopsQuery.data?.runs ?? NO_RUNS;
  const skills = skillsQuery.data ?? NO_SKILLS;
  const velocity = velocityQuery.data;

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  // Mission card click selects a run whose report renders below the rail —
  // often below the fold. Scroll once per selection id so background refetches
  // (trigger/seed invalidations) don't yank the viewport back to the report.
  useEffect(() => {
    if (!selectedRunId || !reportRef.current) return;
    reportRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedRunId]);

  const chipSkills = useMemo(() => {
    const fromDefaults = DEFAULT_SAM_LOOP_TEMPLATES.flatMap((t) => {
      if (t.sourceType !== "skill") return [];
      return [
        {
          name: t.name,
          skillName: t.skillName,
          cadence: t.cadence,
        },
      ];
    });
    // Prefer seeded defaults; fill from skill catalog for chips beyond defaults.
    const seen = new Set<string>(fromDefaults.map((c) => c.skillName));
    const extras = skills
      .filter((s) => !seen.has(s.name))
      .slice(0, 10)
      .map((s) => ({
        name: s.name.replace(/-/g, " "),
        skillName: s.name,
        cadence: "weekly" as const,
      }));
    return [...fromDefaults, ...extras];
  }, [skills]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-6 md:px-6">
      <header className="space-y-2">
        <p className="text-sm font-medium tracking-wide text-primary uppercase">
          Sam loops
        </p>
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
          Put Sam to work
        </h1>
        <p className="max-w-2xl text-base-content/70">
          Schedule skills or custom prompts. Each run writes a plain-English
          report and may queue fix proposals — applying stays behind the gate.
        </p>
      </header>

      <ContentVelocitySection
        isLoading={velocityQuery.isLoading}
        isError={velocityQuery.isError}
        error={velocityQuery.error}
        velocity={velocity}
      />

      <AskSamSection projectId={projectId} />

      {/* Loop chips */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Loop templates</h2>
          <button
            type="button"
            className="btn btn-sm gap-1"
            onClick={() => setShowCreate((v) => !v)}
          >
            <Plus className="size-4" />
            New loop
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {chipSkills.map((chip) => {
            const existing = loops.find(
              (loop) =>
                loop.sourceType === "skill" &&
                loop.skillName === chip.skillName,
            );
            return (
              <button
                key={chip.skillName}
                type="button"
                className={`btn btn-sm gap-2 ${existing?.isEnabled ? "btn-primary btn-outline" : "btn-ghost"}`}
                title={
                  existing
                    ? `${chip.name} · ${existing.cadence} · ${existing.isEnabled ? "on" : "off"}`
                    : `Create ${chip.name}`
                }
                onClick={() => {
                  if (existing) {
                    void triggerMutation.mutateAsync(existing.id);
                    return;
                  }
                  setCreateMode("skill");
                  setCreateSkill(chip.skillName);
                  setCreateName(chip.name);
                  setCreateCadence(chip.cadence);
                  setShowCreate(true);
                }}
              >
                <Repeat className="size-3.5 opacity-70" />
                {chip.name}
              </button>
            );
          })}
        </div>

        {form.showCreate ? (
          <CreateLoopForm
            form={form}
            skills={skills}
            isPending={createMutation.isPending}
            isError={createMutation.isError}
            error={createMutation.error}
            onCreate={() => createMutation.mutate()}
          />
        ) : null}
      </section>

      <LoopsSection
        projectId={projectId}
        loops={loops}
        isLoading={loopsQuery.isLoading}
        invalidate={invalidate}
        triggerMutation={triggerMutation}
      />

      <RunsSection
        runs={runs}
        selectedRun={selectedRun}
        selectedRunId={selectedRunId}
        onSelectRun={setSelectedRunId}
        reportRef={reportRef}
      />
    </div>
  );
}
