import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import {
  HostedPlanGate,
  type HostedPlanGateState,
} from "@/client/features/billing/HostedPlanGate";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  addAiVisibilityTrackingPrompt,
  createAiVisibilityTrackingConfig,
  getAiVisibilityTracking,
  getAiVisibilityTrackingTrend,
  triggerAiVisibilityCheck,
} from "@/serverFunctions/ai-visibility";
import { formatMentionsDisplay } from "@/shared/ai-visibility-mentions";

type Props = {
  projectId: string;
};

export function AiVisibilityPage({ projectId }: Props) {
  return (
    <HostedPlanGate>
      {(planGate) => (
        <AiVisibilityPageInner projectId={projectId} planGate={planGate} />
      )}
    </HostedPlanGate>
  );
}

function AiVisibilityPageInner({
  projectId,
  planGate,
}: Props & { planGate: HostedPlanGateState }) {
  const queryClient = useQueryClient();
  const [brand, setBrand] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);

  const latestQuery = useQuery({
    queryKey: ["ai-visibility", projectId],
    queryFn: () => getAiVisibilityTracking({ data: { projectId } }),
  });

  const trendQuery = useQuery({
    queryKey: ["ai-visibility-trend", projectId, latestQuery.data?.config?.id],
    enabled: Boolean(latestQuery.data?.config?.id),
    queryFn: () =>
      getAiVisibilityTrackingTrend({
        data: {
          projectId,
          configId: latestQuery.data?.config?.id,
        },
      }),
  });

  const createConfig = useMutation({
    mutationFn: () =>
      createAiVisibilityTrackingConfig({
        data: { projectId, brand, scheduleInterval: "manual" },
      }),
    onSuccess: async () => {
      setBrand("");
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["ai-visibility"] });
    },
    onError: (err) => setError(getStandardErrorMessage(err)),
  });

  const addPrompt = useMutation({
    mutationFn: (configId: string) =>
      addAiVisibilityTrackingPrompt({
        data: { projectId, configId, prompt },
      }),
    onSuccess: async () => {
      setPrompt("");
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["ai-visibility"] });
    },
    onError: (err) => setError(getStandardErrorMessage(err)),
  });

  const runCheck = useMutation({
    mutationFn: (configId: string) =>
      triggerAiVisibilityCheck({ data: { projectId, configId } }),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["ai-visibility"] });
      await queryClient.invalidateQueries({
        queryKey: ["ai-visibility-trend"],
      });
    },
    onError: (err) => setError(getStandardErrorMessage(err)),
  });

  const latest = latestQuery.data;
  const config = latest?.config;
  const blockedByPlan = planGate.isFreePlan;

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-1 size-5 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold">AI Visibility Tracking</h1>
          <p className="text-sm text-base-content/70">
            Re-check the same prompts on a schedule and compare runs over time.
          </p>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
          {error}
        </div>
      ) : null}

      {!config ? (
        <div className="rounded-xl border border-base-300 bg-base-100 p-6 space-y-4">
          <p className="text-sm text-base-content/70">
            Not measured yet — create a tracked brand to start.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              className="input input-bordered flex-1"
              placeholder="Brand or domain"
              value={brand}
              onChange={(event) => setBrand(event.target.value)}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={!brand.trim() || createConfig.isPending}
              onClick={() => createConfig.mutate()}
            >
              Start tracking
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-base-300 bg-base-100 p-6 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-medium">{config.brand}</h2>
                <p className="text-sm text-base-content/60">
                  Prompt set v{config.promptSetVersion} ·{" "}
                  {config.scheduleInterval} schedule
                </p>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={
                  blockedByPlan ||
                  runCheck.isPending ||
                  config.prompts.filter((row) => row.isActive).length === 0
                }
                onClick={() => runCheck.mutate(config.id)}
              >
                Run check now
              </button>
            </div>

            {latest?.measured && latest.latestRun ? (
              <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
                <Metric
                  label="Total mentions"
                  value={formatMentionsDisplay(
                    latest.latestRun.totalMentions,
                    latest.latestRun.partialMentions,
                  )}
                  fetchedAt={latest.fetchedAt}
                  source={latest.source}
                />
                <Metric
                  label="Share of voice"
                  value={
                    latest.latestRun.shareOfVoicePct == null
                      ? null
                      : `${latest.latestRun.shareOfVoicePct}%`
                  }
                  fetchedAt={latest.fetchedAt}
                  source={latest.source}
                />
                <Metric
                  label="Prompts with brand"
                  value={latest.latestRun.promptsWithBrand}
                  fetchedAt={latest.fetchedAt}
                  source={latest.source}
                />
                <Metric
                  label="Prompts checked"
                  value={latest.latestRun.promptsChecked}
                  fetchedAt={latest.fetchedAt}
                  source={latest.source}
                />
              </dl>
            ) : (
              <p className="text-sm text-base-content/70">
                Not measured yet — add prompts and run a check.
              </p>
            )}
            {latest?.latestRun?.costNote ? (
              <p className="text-xs text-base-content/60">
                {latest.latestRun.costNote}
              </p>
            ) : null}
          </div>

          <div className="rounded-xl border border-base-300 bg-base-100 p-6 space-y-4">
            <h3 className="font-medium">Tracked prompts</h3>
            {config.prompts.length === 0 ? (
              <p className="text-sm text-base-content/70">No prompts yet.</p>
            ) : (
              <ul className="space-y-2">
                {config.prompts.map((row) => (
                  <li
                    key={row.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-base-200 px-3 py-2 text-sm"
                  >
                    <span className={row.isActive ? "" : "opacity-50"}>
                      {row.prompt}
                    </span>
                    <span className="badge badge-ghost badge-sm">
                      {row.isActive ? "active" : "paused"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                className="input input-bordered flex-1"
                placeholder="Prompt to track"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <button
                type="button"
                className="btn btn-outline"
                disabled={!prompt.trim() || addPrompt.isPending}
                onClick={() => addPrompt.mutate(config.id)}
              >
                Add prompt
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-base-300 bg-base-100 p-6 space-y-3">
            <h3 className="font-medium">Trend</h3>
            {!trendQuery.data?.measured || trendQuery.data.runs.length === 0 ? (
              <p className="text-sm text-base-content/70">Not measured yet.</p>
            ) : (
              <ul className="space-y-2">
                {trendQuery.data.runs.map((run) => (
                  <li
                    key={run.id}
                    className="rounded-lg border border-base-200 px-3 py-2 text-sm"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>{run.finishedAt ?? "unknown time"}</span>
                      <span className="text-base-content/60">
                        v{run.promptSetVersion}
                      </span>
                    </div>
                    <p>
                      Mentions:{" "}
                      {formatMentionsDisplay(
                        run.totalMentions,
                        run.partialMentions,
                      )}
                      {run.delta?.totalMentions != null
                        ? ` (${run.delta.totalMentions >= 0 ? "+" : ""}${run.delta.totalMentions})`
                        : run.delta === null &&
                            trendQuery.data.runs.indexOf(run) > 0
                          ? " · new baseline"
                          : ""}
                    </p>
                    {run.fetchedAt ? (
                      <p className="text-xs text-base-content/50">
                        {run.fetchedAt} · {run.source}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  fetchedAt,
  source,
}: {
  label: string;
  value: string | number | null;
  fetchedAt: string | null;
  source?: string;
}) {
  return (
    <div>
      <dt className="text-base-content/60">{label}</dt>
      <dd className="font-medium">
        {value == null ? "not measured" : value}
      </dd>
      {fetchedAt ? (
        <dd className="text-xs text-base-content/50">
          {fetchedAt} · {source ?? "dataforseo_llm_mentions"}
        </dd>
      ) : null}
    </div>
  );
}
