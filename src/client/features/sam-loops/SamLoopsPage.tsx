import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Repeat,
  Send,
} from "lucide-react";
import {
  createSamLoop,
  getContentVelocity,
  listSamLoopSkills,
  listSamLoops,
  seedDefaultSamLoops,
  triggerSamLoop,
  updateSamLoop,
} from "@/serverFunctions/sam-loops";
import { Markdown } from "@/client/components/Markdown";
import { DEFAULT_SAM_LOOP_TEMPLATES } from "@/shared/sam-loops";

const ROTATING_ASKS = [
  "Identify pages losing traffic and why",
  "What did the site-health loop find?",
  "Where are we slipping in rankings?",
  "Queue title/meta fixes for the homepage",
] as const;

function statusPill(status: string) {
  const tone =
    status === "completed"
      ? "badge-success"
      : status === "failed"
        ? "badge-error"
        : status === "running" || status === "pending"
          ? "badge-warning"
          : "badge-ghost";
  return <span className={`badge badge-sm ${tone}`}>{status}</span>;
}

function formatWhen(iso: string | null | undefined) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatMonthLabel(ym: string) {
  const [year, month] = ym.split("-");
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  return date.toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

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
  const [askDraft, setAskDraft] = useState<string>(ROTATING_ASKS[0]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() =>
    takeSelectedRunHandoff(projectId),
  );
  const reportRef = useRef<HTMLElement>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createMode, setCreateMode] = useState<"skill" | "custom">("skill");
  const [createName, setCreateName] = useState("");
  const [createSkill, setCreateSkill] = useState<string>(
    DEFAULT_SAM_LOOP_TEMPLATES[0]?.skillName ?? "site-health",
  );
  const [createPrompt, setCreatePrompt] = useState("");
  const [createCadence, setCreateCadence] = useState<
    "daily" | "weekly" | "monthly"
  >("weekly");

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

  const toggleMutation = useMutation({
    mutationFn: (input: { loopId: string; isEnabled: boolean }) =>
      updateSamLoop({
        data: {
          projectId,
          loopId: input.loopId,
          isEnabled: input.isEnabled,
        },
      }),
    onSuccess: invalidate,
  });

  const triggerMutation = useMutation({
    mutationFn: (loopId: string) =>
      triggerSamLoop({ data: { projectId, loopId } }),
    onSuccess: invalidate,
  });

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

  const seedDefaultsMutation = useMutation({
    mutationFn: () => seedDefaultSamLoops({ data: { projectId } }),
    onSuccess: invalidate,
  });

  const loops = loopsQuery.data?.loops ?? [];
  const runs = loopsQuery.data?.runs ?? [];
  const skills = skillsQuery.data ?? [];
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

      {/* Content velocity */}
      <section className="space-y-3 rounded-xl bg-base-100 p-4 ring-1 ring-base-300/60">
        <h2 className="text-lg font-semibold">Content velocity</h2>
        {velocityQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-base-content/60">
            <Loader2 className="size-4 animate-spin" />
            Loading velocity…
          </div>
        ) : velocityQuery.isError ? (
          <p className="text-sm text-error">
            {velocityQuery.error instanceof Error
              ? velocityQuery.error.message
              : "Could not load content velocity"}
          </p>
        ) : velocity && velocity.loops.length === 0 ? (
          <p className="text-sm text-base-content/60">
            No content loops set up — enable Monthly content to start drafting.
          </p>
        ) : velocity ? (
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr className="text-base-content/70">
                  <th className="font-medium">Loop</th>
                  <th className="font-medium">Cadence</th>
                  {velocity.months.map((month) => (
                    <th key={month} className="text-right font-medium">
                      {formatMonthLabel(month)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {velocity.loops.map((loop) => {
                  const muted = !loop.isEnabled;
                  return (
                    <tr
                      key={loop.loopId}
                      className={muted ? "text-base-content/50" : undefined}
                    >
                      <td className="font-medium">
                        {loop.loopName}
                        {muted ? (
                          <span className="ml-1 text-xs font-normal">
                            (paused)
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <span className="badge badge-ghost badge-sm">
                          {loop.cadence}
                        </span>
                      </td>
                      {velocity.months.map((month) => {
                        const drafted = loop.drafted[month] ?? 0;
                        const withoutDraft =
                          loop.completedWithoutDraft[month] ?? 0;
                        return (
                          <td key={month} className="text-right align-top">
                            <div>
                              {drafted}/{loop.expectedPerMonth}
                            </div>
                            {withoutDraft > 0 ? (
                              <div className="text-xs text-base-content/50">
                                +{withoutDraft} completed without draft
                              </div>
                            ) : null}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="text-xs text-base-content/50">
          Counts are completed loop runs that produced a draft; expected pace is
          approximate (monthly=1, weekly=4, daily=30).
        </p>
      </section>

      {/* Ask Sam affordance */}
      <section className="rounded-2xl bg-gradient-to-br from-base-200 via-base-100 to-base-200 p-4 shadow-sm ring-1 ring-base-300/60 md:p-5">
        <label className="mb-2 block text-sm font-medium text-base-content/80">
          Ask Sam
        </label>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
          <input
            className="input input-bordered w-full flex-1 bg-base-100"
            value={askDraft}
            onChange={(e) => setAskDraft(e.target.value)}
            placeholder={ROTATING_ASKS[0]}
          />
          <Link
            to="/p/$projectId/sam"
            params={{ projectId }}
            search={{}}
            className="btn btn-primary gap-2"
            onClick={() => {
              // Hand the draft to Sam chat via sessionStorage (read on mount).
              try {
                sessionStorage.setItem(
                  `sam-loops-ask:${projectId}`,
                  askDraft.trim(),
                );
              } catch {
                // ignore
              }
            }}
          >
            <Send className="size-4" />
            Send
          </Link>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {ROTATING_ASKS.map((ask) => (
            <button
              key={ask}
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => setAskDraft(ask)}
            >
              {ask}
            </button>
          ))}
        </div>
      </section>

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

        {showCreate ? (
          <div className="mt-2 space-y-3 rounded-xl bg-base-200/60 p-4 ring-1 ring-base-300/50">
            <div className="flex gap-2">
              <button
                type="button"
                className={`btn btn-xs ${createMode === "skill" ? "btn-active" : ""}`}
                onClick={() => setCreateMode("skill")}
              >
                From skill
              </button>
              <button
                type="button"
                className={`btn btn-xs ${createMode === "custom" ? "btn-active" : ""}`}
                onClick={() => setCreateMode("custom")}
              >
                Custom prompt
              </button>
            </div>
            <input
              className="input input-bordered input-sm w-full"
              placeholder="Loop name"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
            />
            {createMode === "skill" ? (
              <select
                className="select select-bordered select-sm w-full"
                value={createSkill}
                onChange={(e) => setCreateSkill(e.target.value)}
              >
                {(skills.length > 0
                  ? skills
                  : DEFAULT_SAM_LOOP_TEMPLATES.flatMap((t) =>
                      t.sourceType === "skill"
                        ? [{ name: t.skillName, description: t.name }]
                        : [],
                    )
                ).map((skill) => (
                  <option key={skill.name} value={skill.name}>
                    {skill.name}
                  </option>
                ))}
              </select>
            ) : (
              <textarea
                className="textarea textarea-bordered w-full text-sm"
                rows={4}
                placeholder="Custom prompt for Sam…"
                value={createPrompt}
                onChange={(e) => setCreatePrompt(e.target.value)}
              />
            )}
            <select
              className="select select-bordered select-sm w-full max-w-xs"
              value={createCadence}
              onChange={(e) =>
                setCreateCadence(
                  e.target.value as "daily" | "weekly" | "monthly",
                )
              }
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={
                  !createName.trim() ||
                  createMutation.isPending ||
                  (createMode === "custom" && !createPrompt.trim())
                }
                onClick={() => createMutation.mutate()}
              >
                {createMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  "Create"
                )}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
            </div>
            {createMutation.isError ? (
              <p className="text-sm text-error">
                {createMutation.error instanceof Error
                  ? createMutation.error.message
                  : "Could not create loop"}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* Configured loops */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Your loops</h2>
          <button
            type="button"
            className="btn btn-ghost btn-xs gap-1"
            onClick={invalidate}
          >
            <RefreshCw className="size-3.5" />
            Refresh
          </button>
        </div>
        {loopsQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-base-content/60">
            <Loader2 className="size-4 animate-spin" />
            Loading loops…
          </div>
        ) : loops.length === 0 ? (
          <div className="space-y-3 rounded-xl bg-base-200/50 px-4 py-8 text-center">
            <p className="text-sm text-base-content/60">
              No loops yet. Use a template chip or create a custom prompt loop.
            </p>
            <button
              type="button"
              className="btn btn-primary btn-sm gap-1"
              disabled={seedDefaultsMutation.isPending}
              onClick={() => seedDefaultsMutation.mutate()}
            >
              {seedDefaultsMutation.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Plus className="size-3.5" />
              )}
              Add Sam&apos;s starter loops
            </button>
            {seedDefaultsMutation.isError ? (
              <p className="text-sm text-error">
                {seedDefaultsMutation.error instanceof Error
                  ? seedDefaultsMutation.error.message
                  : "Could not add starter loops"}
              </p>
            ) : null}
          </div>
        ) : (
          <ul className="divide-y divide-base-300/60 overflow-hidden rounded-xl ring-1 ring-base-300/50">
            {loops.map((loop) => (
              <li
                key={loop.id}
                className="flex flex-col gap-3 bg-base-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{loop.name}</span>
                    <span className="badge badge-ghost badge-sm">
                      {loop.cadence}
                    </span>
                    {loop.sourceType === "skill" ? (
                      <span className="badge badge-outline badge-sm">
                        {loop.skillName}
                      </span>
                    ) : (
                      <span className="badge badge-outline badge-sm">
                        custom
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-base-content/55">
                    Last run {formatWhen(loop.lastRunAt)} · Next{" "}
                    {formatWhen(loop.nextRunAt)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="toggle toggle-sm toggle-primary"
                      checked={loop.isEnabled}
                      disabled={toggleMutation.isPending}
                      onChange={(e) =>
                        toggleMutation.mutate({
                          loopId: loop.id,
                          isEnabled: e.target.checked,
                        })
                      }
                    />
                    {loop.isEnabled ? "On" : "Off"}
                  </label>
                  <button
                    type="button"
                    className="btn btn-sm gap-1"
                    disabled={
                      !loop.isEnabled ||
                      triggerMutation.isPending ||
                      triggerMutation.variables === loop.id
                    }
                    onClick={() => triggerMutation.mutate(loop.id)}
                  >
                    {triggerMutation.isPending &&
                    triggerMutation.variables === loop.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Play className="size-3.5" />
                    )}
                    Run now
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Missions / runs rail */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Your missions</h2>
        {runs.length === 0 ? (
          <p className="rounded-xl bg-base-200/50 px-4 py-8 text-center text-sm text-base-content/60">
            No runs yet. Enable a loop or hit Run now — reports land here.
          </p>
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-2">
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => setSelectedRunId(run.id)}
                className={`min-w-[220px] max-w-[280px] shrink-0 rounded-xl px-4 py-3 text-left ring-1 transition ${
                  selectedRunId === run.id
                    ? "bg-primary/10 ring-primary/40"
                    : "bg-base-100 ring-base-300/60 hover:bg-base-200/40"
                }`}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {"loopName" in run ? String(run.loopName) : "Loop"}
                  </span>
                  {statusPill(run.status)}
                </div>
                <p className="text-xs text-base-content/55">
                  {formatWhen(run.finishedAt ?? run.startedAt ?? run.createdAt)}
                </p>
                {run.proposalsQueued > 0 ? (
                  <p className="mt-1 text-xs text-primary">
                    {run.proposalsQueued} proposal
                    {run.proposalsQueued === 1 ? "" : "s"} queued
                  </p>
                ) : null}
              </button>
            ))}
          </div>
        )}

        {selectedRun ? (
          <article
            key={selectedRun.id}
            ref={reportRef}
            className="animate-in fade-in slide-in-from-bottom-1 space-y-2 rounded-xl bg-base-100 p-4 ring-1 ring-base-300/60 duration-200"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">
                {"loopName" in selectedRun
                  ? String(selectedRun.loopName)
                  : "Run report"}
              </h3>
              {statusPill(selectedRun.status)}
              {selectedRun.costNote ? (
                <span className="badge badge-ghost badge-sm">
                  {selectedRun.costNote}
                </span>
              ) : null}
            </div>
            <Markdown className="whitespace-pre-wrap text-sm leading-relaxed text-base-content/85">
              {selectedRun.report ??
                selectedRun.error ??
                "not measured — no report yet."}
            </Markdown>
          </article>
        ) : null}
      </section>
    </div>
  );
}
