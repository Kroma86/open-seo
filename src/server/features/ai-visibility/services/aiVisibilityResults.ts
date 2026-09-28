import { AiVisibilityRepository } from "@/server/features/ai-visibility/repositories/AiVisibilityRepository";
import {
  extractPromptResults,
  type PromptResults,
} from "@/server/features/ai-visibility/services/aiVisibilityPromptResults";
import { AppError } from "@/server/lib/errors";
import {
  parseCompetitorsJson,
  parsePlatformsJson,
} from "@/shared/ai-visibility";
import type {
  AiVisibilityLatestResults,
  AiVisibilityTrend,
  AiVisibilityTrendPoint,
} from "@/types/schemas/ai-visibility";

const SOURCE = "dataforseo_llm_mentions" as const;

function parsePartialMentionsFromDetail(detail: string | null): boolean {
  if (!detail) return false;
  try {
    const parsed: unknown = JSON.parse(detail);
    if (!parsed || typeof parsed !== "object") return false;
    const brandLookup = (parsed as { brandLookup?: { partialMentions?: boolean } })
      .brandLookup;
    return Boolean(brandLookup?.partialMentions);
  } catch {
    return false;
  }
}

function notMeasuredLatest(): AiVisibilityLatestResults {
  return {
    measured: false,
    source: SOURCE,
    fetchedAt: null,
    config: null,
    latestRun: null,
  };
}

function computeDelta(
  current: Awaited<
    ReturnType<typeof AiVisibilityRepository.getCompletedRunsForConfig>
  >[number],
  previous: Awaited<
    ReturnType<typeof AiVisibilityRepository.getCompletedRunsForConfig>
  >[number],
): AiVisibilityTrendPoint["delta"] {
  if (current.promptSetVersion !== previous.promptSetVersion) {
    return null;
  }

  const diff = (next: number | null, prev: number | null) =>
    next == null || prev == null ? null : next - prev;

  return {
    totalMentions: diff(current.totalMentions, previous.totalMentions),
    shareOfVoicePct: diff(current.shareOfVoicePct, previous.shareOfVoicePct),
    promptsWithBrand: diff(current.promptsWithBrand, previous.promptsWithBrand),
    promptsChecked: diff(current.promptsChecked, previous.promptsChecked),
  };
}

async function resolveConfig(projectId: string, configId?: string) {
  if (configId) {
    return AiVisibilityRepository.getConfigById({ configId, projectId });
  }
  const configs = await AiVisibilityRepository.getConfigsForProject(projectId);
  return configs[0] ?? null;
}

export async function getLatestResults(
  projectId: string,
  configId?: string,
): Promise<AiVisibilityLatestResults> {
  const config = await resolveConfig(projectId, configId);
  if (!config) return notMeasuredLatest();

  const [prompts, latestRun] = await Promise.all([
    AiVisibilityRepository.getPromptsForConfig(config.id),
    AiVisibilityRepository.getLatestCompletedRunForConfig(config.id),
  ]);

  if (!latestRun) {
    return {
      measured: false,
      source: SOURCE,
      fetchedAt: null,
      config: {
        id: config.id,
        brand: config.brand,
        competitors: parseCompetitorsJson(config.competitors),
        platforms: parsePlatformsJson(config.platforms),
        scheduleInterval: config.scheduleInterval,
        promptSetVersion: config.promptSetVersion,
        prompts: prompts.map((row) => ({
          id: row.id,
          prompt: row.prompt,
          isActive: row.isActive,
        })),
      },
      latestRun: null,
    };
  }

  const partialMentions = parsePartialMentionsFromDetail(latestRun.detail);

  return {
    measured: true,
    source: SOURCE,
    fetchedAt: latestRun.finishedAt,
    config: {
      id: config.id,
      brand: config.brand,
      competitors: parseCompetitorsJson(config.competitors),
      platforms: parsePlatformsJson(config.platforms),
      scheduleInterval: config.scheduleInterval,
      promptSetVersion: config.promptSetVersion,
      prompts: prompts.map((row) => ({
        id: row.id,
        prompt: row.prompt,
        isActive: row.isActive,
      })),
    },
    latestRun: {
      id: latestRun.id,
      status: latestRun.status,
      finishedAt: latestRun.finishedAt,
      totalMentions: latestRun.totalMentions,
      partialMentions,
      shareOfVoicePct: latestRun.shareOfVoicePct,
      promptsWithBrand: latestRun.promptsWithBrand,
      promptsChecked: latestRun.promptsChecked,
      promptSetVersion: latestRun.promptSetVersion,
      costNote: latestRun.costNote,
      error: latestRun.error,
    },
  };
}

export async function getTrend(
  projectId: string,
  configId?: string,
  limit = 20,
): Promise<AiVisibilityTrend> {
  const config = await resolveConfig(projectId, configId);
  if (!config) {
    return {
      measured: false,
      source: SOURCE,
      configId: null,
      promptSetVersion: null,
      runs: [],
    };
  }

  const runs = await AiVisibilityRepository.getCompletedRunsForConfig(
    config.id,
    limit,
  );
  if (runs.length === 0) {
    return {
      measured: false,
      source: SOURCE,
      configId: config.id,
      promptSetVersion: config.promptSetVersion,
      runs: [],
    };
  }

  const points: AiVisibilityTrendPoint[] = runs.map((run, index) => {
    const previous = runs[index + 1];
    return {
      id: run.id,
      finishedAt: run.finishedAt,
      fetchedAt: run.finishedAt,
      source: SOURCE,
      promptSetVersion: run.promptSetVersion,
      totalMentions: run.totalMentions,
      partialMentions: parsePartialMentionsFromDetail(run.detail),
      shareOfVoicePct: run.shareOfVoicePct,
      promptsWithBrand: run.promptsWithBrand,
      promptsChecked: run.promptsChecked,
      delta: previous ? computeDelta(run, previous) : null,
    };
  });

  return {
    measured: true,
    source: SOURCE,
    configId: config.id,
    promptSetVersion: runs[0]?.promptSetVersion ?? config.promptSetVersion,
    runs: points,
  };
}

async function resolveCompletedRun(
  projectId: string,
  configId: string | undefined,
  runId: string | undefined,
) {
  if (!runId) {
    const config = await resolveConfig(projectId, configId);
    return config
      ? AiVisibilityRepository.getLatestCompletedRunForConfig(config.id)
      : null;
  }
  const run = await AiVisibilityRepository.getRunById(runId);
  // Same miss for another project's run as for no run: never confirm it exists.
  if (
    !run ||
    run.projectId !== projectId ||
    (configId && run.configId !== configId) ||
    run.status !== "completed"
  ) {
    throw new AppError("NOT_FOUND", "AI visibility run not found");
  }
  return run;
}

/**
 * Per-question results of one completed run, read from stored detail only.
 * Null when the project has no completed run yet.
 */
export async function getPromptResults(
  projectId: string,
  configId?: string,
  runId?: string,
): Promise<PromptResults | null> {
  const run = await resolveCompletedRun(projectId, configId, runId);
  if (!run) return null;
  return extractPromptResults(run.detail, {
    runId: run.id,
    completedAt: run.finishedAt,
    promptSetVersion: run.promptSetVersion,
  });
}

/** Latest completed-run summary for agency score export. */
export async function getAgencyExportBlock(projectId: string) {
  const latest = await getLatestResults(projectId);
  if (!latest.measured || !latest.latestRun) return null;
  return {
    capturedAt: latest.fetchedAt,
    source: SOURCE,
    totalMentions: latest.latestRun.totalMentions,
    partialMentions: latest.latestRun.partialMentions,
    shareOfVoicePct: latest.latestRun.shareOfVoicePct,
    promptsWithBrand: latest.latestRun.promptsWithBrand,
    promptsChecked: latest.latestRun.promptsChecked,
    promptSetVersion: latest.latestRun.promptSetVersion,
  };
}
