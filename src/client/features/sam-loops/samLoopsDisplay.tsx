import { Link } from "@tanstack/react-router";
import { useState, type RefObject } from "react";
import { Loader2, Send } from "lucide-react";
import type {
  getContentVelocity,
  listSamLoops,
} from "@/serverFunctions/sam-loops";
import { Markdown } from "@/client/components/Markdown";

type SamLoopsData = Awaited<ReturnType<typeof listSamLoops>>;
export type SamLoopRow = SamLoopsData["loops"][number];
export type SamLoopRunRow = SamLoopsData["runs"][number];
type ContentVelocityData = Awaited<ReturnType<typeof getContentVelocity>>;

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

export function formatWhen(iso: string | null | undefined) {
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

function ContentVelocityTable({ velocity }: { velocity: ContentVelocityData }) {
  return (
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
                    <span className="ml-1 text-xs font-normal">(paused)</span>
                  ) : null}
                </td>
                <td>
                  <span className="badge badge-ghost badge-sm">
                    {loop.cadence}
                  </span>
                </td>
                {velocity.months.map((month) => {
                  const drafted = loop.drafted[month] ?? 0;
                  const withoutDraft = loop.completedWithoutDraft[month] ?? 0;
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
  );
}

export function ContentVelocitySection({
  isLoading,
  isError,
  error,
  velocity,
}: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  velocity: ContentVelocityData | undefined;
}) {
  return (
    <section className="space-y-3 rounded-xl bg-base-100 p-4 ring-1 ring-base-300/60">
      <h2 className="text-lg font-semibold">Content velocity</h2>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-base-content/60">
          <Loader2 className="size-4 animate-spin" />
          Loading velocity…
        </div>
      ) : isError ? (
        <p className="text-sm text-error">
          {error instanceof Error
            ? error.message
            : "Could not load content velocity"}
        </p>
      ) : velocity && velocity.loops.length === 0 ? (
        <p className="text-sm text-base-content/60">
          No content loops set up — enable Monthly content to start drafting.
        </p>
      ) : velocity ? (
        <ContentVelocityTable velocity={velocity} />
      ) : null}
      <p className="text-xs text-base-content/50">
        Counts are completed loop runs that produced a draft; expected pace is
        approximate (monthly=1, weekly=4, daily=30).
      </p>
    </section>
  );
}

export function AskSamSection({ projectId }: { projectId: string }) {
  const [askDraft, setAskDraft] = useState<string>(ROTATING_ASKS[0]);
  return (
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
  );
}

export function RunsSection({
  runs,
  selectedRun,
  selectedRunId,
  onSelectRun,
  reportRef,
}: {
  runs: SamLoopRunRow[];
  selectedRun: SamLoopRunRow | null;
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  reportRef: RefObject<HTMLElement | null>;
}) {
  return (
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
              onClick={() => onSelectRun(run.id)}
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
  );
}
