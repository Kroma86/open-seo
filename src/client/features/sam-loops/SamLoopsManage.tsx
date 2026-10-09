import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Loader2, Play, Plus, RefreshCw } from "lucide-react";
import {
  seedDefaultSamLoops,
  triggerSamLoop,
  updateSamLoop,
  type listSamLoopSkills,
} from "@/serverFunctions/sam-loops";
import { DEFAULT_SAM_LOOP_TEMPLATES } from "@/shared/sam-loops";
import { formatWhen, type SamLoopRow } from "./samLoopsDisplay";

export type SamLoopSkill = Awaited<
  ReturnType<typeof listSamLoopSkills>
>[number];

const LOOP_CADENCES = ["daily", "weekly", "monthly"] as const;
type LoopCadence = (typeof LOOP_CADENCES)[number];

function isLoopCadence(value: string): value is LoopCadence {
  return LOOP_CADENCES.some((cadence) => cadence === value);
}

export function useCreateLoopForm() {
  const [showCreate, setShowCreate] = useState(false);
  const [createMode, setCreateMode] = useState<"skill" | "custom">("skill");
  const [createName, setCreateName] = useState("");
  const [createSkill, setCreateSkill] = useState<string>(
    DEFAULT_SAM_LOOP_TEMPLATES[0]?.skillName ?? "site-health",
  );
  const [createPrompt, setCreatePrompt] = useState("");
  const [createCadence, setCreateCadence] = useState<LoopCadence>("weekly");
  return {
    showCreate,
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
  };
}

type CreateLoopFormState = ReturnType<typeof useCreateLoopForm>;

export function useTriggerLoopMutation(
  projectId: string,
  onSuccess: () => void,
) {
  return useMutation({
    mutationFn: (loopId: string) =>
      triggerSamLoop({ data: { projectId, loopId } }),
    onSuccess,
  });
}

type TriggerLoopMutation = ReturnType<typeof useTriggerLoopMutation>;

export function CreateLoopForm({
  form,
  skills,
  isPending,
  isError,
  error,
  onCreate,
}: {
  form: CreateLoopFormState;
  skills: SamLoopSkill[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  onCreate: () => void;
}) {
  const {
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
    setShowCreate,
  } = form;
  return (
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
        onChange={(e) => {
          const cadence = e.target.value;
          if (isLoopCadence(cadence)) setCreateCadence(cadence);
        }}
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
            isPending ||
            (createMode === "custom" && !createPrompt.trim())
          }
          onClick={onCreate}
        >
          {isPending ? <Loader2 className="size-4 animate-spin" /> : "Create"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setShowCreate(false)}
        >
          Cancel
        </button>
      </div>
      {isError ? (
        <p className="text-sm text-error">
          {error instanceof Error ? error.message : "Could not create loop"}
        </p>
      ) : null}
    </div>
  );
}

function LoopRow({
  loop,
  toggleDisabled,
  onToggle,
  triggerMutation,
}: {
  loop: SamLoopRow;
  toggleDisabled: boolean;
  onToggle: (isEnabled: boolean) => void;
  triggerMutation: TriggerLoopMutation;
}) {
  return (
    <li className="flex flex-col gap-3 bg-base-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{loop.name}</span>
          <span className="badge badge-ghost badge-sm">{loop.cadence}</span>
          {loop.sourceType === "skill" ? (
            <span className="badge badge-outline badge-sm">
              {loop.skillName}
            </span>
          ) : (
            <span className="badge badge-outline badge-sm">custom</span>
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
            disabled={toggleDisabled}
            onChange={(e) => onToggle(e.target.checked)}
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
  );
}

export function LoopsSection({
  projectId,
  loops,
  isLoading,
  invalidate,
  triggerMutation,
}: {
  projectId: string;
  loops: SamLoopRow[];
  isLoading: boolean;
  invalidate: () => void;
  triggerMutation: TriggerLoopMutation;
}) {
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

  const seedDefaultsMutation = useMutation({
    mutationFn: () => seedDefaultSamLoops({ data: { projectId } }),
    onSuccess: invalidate,
  });

  return (
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
      {isLoading ? (
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
            <LoopRow
              key={loop.id}
              loop={loop}
              toggleDisabled={toggleMutation.isPending}
              onToggle={(isEnabled) =>
                toggleMutation.mutate({ loopId: loop.id, isEnabled })
              }
              triggerMutation={triggerMutation}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
