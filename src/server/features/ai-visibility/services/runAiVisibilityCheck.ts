import type { BillingCustomerContext } from "@/server/billing/subscription";
import { textMentionsBrand } from "@/server/features/ai-search/services/brandMatch";
import { getBrandLookup } from "@/server/features/ai-search/services/brandLookup";
import { explorePrompt } from "@/server/features/ai-search/services/promptExplorer";
import {
  WEEKLY_JEV_CAP_USD,
  gradeAnswerName,
  type NameBudget,
} from "@/server/features/ai-visibility/services/brandNameDecision";
import { askJevNamed } from "@/server/features/ai-visibility/services/jevBrandName";
import {
  decideSweep,
  findReusableLookup,
  PULSE_MODEL_NAMES,
  PULSE_MODELS,
  type AiVisibilitySweep,
  type StoredBrandLookup,
} from "@/server/features/ai-visibility/services/aiVisibilitySweep";
import { AiVisibilityRepository } from "@/server/features/ai-visibility/repositories/AiVisibilityRepository";
import {
  AiVisibilityManagementService,
  type AiVisibilityCheckTrigger,
  type AiVisibilityCheckTriggerResult,
} from "@/server/features/ai-visibility/services/AiVisibilityManagementService";
import {
  beginAiVisibilityRun,
  failRunIfActive,
} from "@/server/features/ai-visibility/services/aiVisibilityRunGuards";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { AppError } from "@/server/lib/errors";
import {
  brandLookupPlatforms,
  parseCompetitorsJson,
  parsePlatformsJson,
  promptExplorerModelsForPlatforms,
} from "@/shared/ai-visibility";
import { sumMentionsForPlatforms } from "@/shared/ai-visibility-mentions";
import type {
  BrandLookupResult,
  PromptExplorerModel,
  PromptExplorerResult,
} from "@/types/schemas/ai-search";

type RunDetail = {
  source: "dataforseo_llm_mentions";
  sweep: AiVisibilitySweep;
  models: PromptExplorerModel[];
  promptsAttempted: number;
  jevSpendUsd: number;
  brandLookup: {
    fetchedAt: string;
    totalMentions: number | null;
    partialMentions: boolean;
    shareOfVoicePct: number | null;
    perPlatform: BrandLookupResult["perPlatform"];
    topCitedSources: BrandLookupResult["topPages"];
    reused?: boolean;
    reusedFromRunId?: string;
  };
  prompts: Array<{
    promptId: string;
    prompt: string;
    fetchedAt: string | null;
    error?: string;
    results: PromptExplorerResult["results"];
  }>;
};

function targetSharePct(brandLookup: BrandLookupResult): number | null {
  const entry = brandLookup.shareOfVoice?.entries.find((row) => row.isTarget);
  return entry?.sharePct ?? null;
}

function promptRowMentionsBrand(
  results: PromptExplorerResult["results"],
): boolean | null {
  const flags = results
    .map((row) => (row.status === "success" ? row.brandMentioned : null))
    .filter((value): value is boolean => value != null);
  if (flags.length === 0) return null;
  return flags.some(Boolean);
}

// A provider hiccup ("model temporarily unavailable") leaves no usable answer
// for a question. Ask once more; a retry that also fails or throws keeps the
// first result. Each retry is one more paid call, counted in the cost note.
async function exploreWithOneRetry(
  ask: () => Promise<PromptExplorerResult>,
): Promise<{ explorer: PromptExplorerResult; retried: boolean }> {
  const explorer = await ask();
  if (promptRowMentionsBrand(explorer.results) !== null) {
    return { explorer, retried: false };
  }
  try {
    const retry = await ask();
    const usable = promptRowMentionsBrand(retry.results) !== null;
    return { explorer: usable ? retry : explorer, retried: true };
  } catch {
    return { explorer, retried: true };
  }
}

function countPromptsWithDefinitiveAnswer(
  promptResults: RunDetail["prompts"],
): number {
  return promptResults.filter(
    (row) => promptRowMentionsBrand(row.results) !== null,
  ).length;
}

function countPromptsWithBrand(
  promptResults: RunDetail["prompts"],
): number | null {
  const withAnswer = promptResults.filter(
    (row) => promptRowMentionsBrand(row.results) !== null,
  );
  if (withAnswer.length === 0) return null;
  return withAnswer.filter(
    (row) => promptRowMentionsBrand(row.results) === true,
  ).length;
}

// getBrandLookup exposes no cache/paid signal, and any freshness heuristic
// mislabels in one direction or the other — say so honestly in both cases.
function buildCostNote(input: {
  promptExplorerCalls: number;
  sweep: AiVisibilitySweep;
  models: PromptExplorerModel[];
  reusedFromRunId?: string;
}): string {
  const promptPart =
    input.promptExplorerCalls === 0
      ? null
      : `${input.promptExplorerCalls} prompt check(s): cache/paid uncertain`;
  if (input.sweep === "pulse") {
    const engines =
      input.models.length === 0 ? "no prompt engines" : "perplexity sonar";
    const prefix = `pulse (${engines}); brand lookup reused from run ${input.reusedFromRunId ?? ""}`;
    return promptPart ? `${prefix}; ${promptPart}` : prefix;
  }
  const prefix = `full sweep (${input.models.length} engine(s): ${input.models.join(", ")})`;
  const brandLabel = "brand lookup cache/paid uncertain";
  return promptPart
    ? `${prefix}; ${brandLabel}; ${promptPart}`
    : `${prefix}; ${brandLabel}`;
}

async function applyNameGrades(
  results: PromptExplorerResult["results"],
  brand: string,
  website: string,
  budget: NameBudget,
): Promise<void> {
  for (const row of results) {
    // Older fixtures omit `text`. Leave their stored flag alone.
    if (row.status !== "success" || typeof row.text !== "string") continue;
    const grade = await gradeAnswerName({
      brand,
      website,
      text: row.text,
      askJev: askJevNamed,
      // A Jev failure, full cap or open breaker keeps the old verdict exactly:
      // the one promptExplorer already stored (citation title or hostname,
      // then the token matcher), not the token matcher alone (Grok r2).
      fallbackNamed:
        typeof row.brandMentioned === "boolean"
          ? row.brandMentioned
          : textMentionsBrand(row.text, brand),
      budget,
    });
    row.brandMentioned = grade.named;
    row.nameProbability = grade.p;
    row.nameUnsure = grade.unsure;
    row.nameSource = grade.source;
  }
}

function reusedBrandLookup(reusable: {
  runId: string;
  brandLookup: StoredBrandLookup;
}): RunDetail["brandLookup"] {
  return {
    ...reusable.brandLookup,
    reused: true,
    reusedFromRunId: reusable.runId,
  };
}

async function executeRun(input: {
  runId: string;
  configId: string;
  projectId: string;
  billingCustomer: BillingCustomerContext;
  nameBudget: NameBudget;
  trigger: AiVisibilityCheckTrigger;
}): Promise<"completed" | "reclaimed"> {
  const config = await AiVisibilityManagementService.getValidatedConfig(
    input.configId,
    input.projectId,
  );
  const project = await ProjectRepository.getProjectForOrganization(
    input.projectId,
    input.billingCustomer.organizationId,
  );
  if (!project) {
    throw new AppError("NOT_FOUND", "Project not found");
  }

  const platforms = parsePlatformsJson(config.platforms);
  const competitors = parseCompetitorsJson(config.competitors);
  const activePrompts = await AiVisibilityRepository.getActivePromptsForConfig(
    input.configId,
  );
  const lookupPlatforms = brandLookupPlatforms(platforms);

  // CAS like the terminal updates: if the reconciler reclaimed this run
  // while it sat pending, do not resurrect it — abort before any paid call.
  const startedAt = new Date().toISOString();
  const claimed = await AiVisibilityRepository.updateRunIfInFlight(
    input.runId,
    { status: "running", startedAt },
    { requireRunning: false },
  );
  if (!claimed) {
    console.warn(
      `AI visibility: run ${input.runId} was reclaimed before it started`,
    );
    return "reclaimed";
  }

  let reusable: ReturnType<typeof findReusableLookup> = null;
  try {
    const priorRuns = await AiVisibilityRepository.getCompletedRunsForConfig(
      input.configId,
      8,
    );
    reusable = findReusableLookup(priorRuns);
  } catch (error) {
    console.warn(
      `AI visibility: prior runs unavailable for ${input.configId}; running a full sweep`,
      error,
    );
    reusable = null;
  }
  const decided = decideSweep({
    trigger: input.trigger,
    scheduleInterval: config.scheduleInterval,
    configId: input.configId,
    now: new Date(),
    lastFreshLookupAt: reusable?.fetchedAt ?? null,
  });
  const sweep: AiVisibilitySweep =
    decided === "pulse" && reusable ? "pulse" : "full";
  const configuredModels = promptExplorerModelsForPlatforms(platforms);
  // A config with no prompt engines (mentions only) stays prompt-free on pulses.
  const explorerModels =
    sweep === "pulse" && configuredModels.length > 0
      ? PULSE_MODELS
      : configuredModels;

  let promptExplorerCalls = 0;
  let promptRetries = 0;
  // The budget can be shared by every config in a scheduled tick; this run
  // stores only what it spent itself.
  const jevSpentBefore = input.nameBudget.spentUsd;

  let brandLookupBlock: RunDetail["brandLookup"];
  if (sweep === "pulse" && reusable) {
    brandLookupBlock = reusedBrandLookup(reusable);
  } else {
    const brandLookup = await getBrandLookup(
      {
        projectId: input.projectId,
        query: config.brand,
        competitors,
        locationCode: project.locationCode,
        languageCode: project.languageCode,
      },
      input.billingCustomer,
    );
    const filteredPlatformRows = brandLookup.perPlatform.filter((row) =>
      lookupPlatforms.includes(row.platform),
    );
    const mentionsSum = sumMentionsForPlatforms(brandLookup, lookupPlatforms);
    brandLookupBlock = {
      fetchedAt: brandLookup.fetchedAt,
      totalMentions: mentionsSum.total,
      partialMentions: mentionsSum.partialMentions,
      shareOfVoicePct: targetSharePct(brandLookup),
      perPlatform: filteredPlatformRows,
      topCitedSources: brandLookup.topPages.slice(0, 10),
    };
  }
  const promptResults: RunDetail["prompts"] = [];
  // Up to 10 prompts, each explorePrompt call isolated in try/catch so one
  // failure cannot abort the run. Models for one prompt run in parallel
  // inside explorePrompt, so a four-engine full sweep does not multiply the
  // wait. Worst case is still about 20 sequential rounds (a question may be
  // asked twice), which fits the 60-minute stale threshold
  // (STALE_AI_VISIBILITY_RUN_MS).
  for (const trackedPrompt of activePrompts) {
    if (explorerModels.length === 0) {
      promptResults.push({
        promptId: trackedPrompt.id,
        prompt: trackedPrompt.prompt,
        fetchedAt: null,
        results: [],
      });
      continue;
    }

    promptExplorerCalls += 1;
    try {
      const ask = () =>
        explorePrompt(
          {
            projectId: input.projectId,
            prompt: trackedPrompt.prompt,
            models: explorerModels,
            highlightBrand: config.brand,
            webSearch: true,
            ...(sweep === "pulse"
              ? { modelNameOverrides: PULSE_MODEL_NAMES }
              : {}),
          },
          input.billingCustomer,
        );
      const { explorer, retried } = await exploreWithOneRetry(ask);
      if (retried) promptRetries += 1;
      await applyNameGrades(
        explorer.results,
        config.brand,
        project.domain ?? "",
        input.nameBudget,
      );
      promptResults.push({
        promptId: trackedPrompt.id,
        prompt: trackedPrompt.prompt,
        fetchedAt: explorer.fetchedAt,
        results: explorer.results,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Prompt explorer failed";
      promptResults.push({
        promptId: trackedPrompt.id,
        prompt: trackedPrompt.prompt,
        fetchedAt: null,
        error: message,
        results: [],
      });
    }
  }

  const promptsChecked = countPromptsWithDefinitiveAnswer(promptResults);
  const promptsWithBrand = countPromptsWithBrand(promptResults);

  const detail: RunDetail = {
    source: "dataforseo_llm_mentions",
    sweep,
    models: explorerModels,
    promptsAttempted: promptExplorerCalls,
    jevSpendUsd: input.nameBudget.spentUsd - jevSpentBefore,
    brandLookup: brandLookupBlock,
    prompts: promptResults,
  };

  const finishedAt = new Date().toISOString();
  const completed = await AiVisibilityRepository.updateRunIfInFlight(
    input.runId,
    {
      status: "completed",
      finishedAt,
      totalMentions: detail.brandLookup.totalMentions,
      shareOfVoicePct: detail.brandLookup.shareOfVoicePct,
      promptsWithBrand,
      promptsChecked,
      detail: JSON.stringify(detail),
      costNote: buildCostNote({
        promptExplorerCalls: promptExplorerCalls + promptRetries,
        sweep,
        models: explorerModels,
        reusedFromRunId: reusable?.runId,
      }),
    },
    { requireRunning: true },
  );
  if (!completed) {
    console.log(
      `AI visibility: run ${input.runId} was reclaimed before completion`,
    );
    return "reclaimed";
  }

  await AiVisibilityRepository.updateConfig(input.configId, input.projectId, {
    lastRunAt: finishedAt,
  });
  return "completed";
}

export async function runAiVisibilityCheck(input: {
  configId: string;
  projectId: string;
  billingCustomer: BillingCustomerContext;
  trigger: AiVisibilityCheckTrigger;
  /** Shared across one weekly pass so the estate stays within the cap. */
  nameBudget?: NameBudget;
}): Promise<AiVisibilityCheckTriggerResult> {
  await AiVisibilityManagementService.requireAiVisibilityAccess(
    input.billingCustomer.organizationId,
  );

  const config = await AiVisibilityManagementService.getValidatedConfig(
    input.configId,
    input.projectId,
  );

  const begin = await beginAiVisibilityRun({
    configId: input.configId,
    projectId: input.projectId,
    promptSetVersion: config.promptSetVersion,
  });
  if (!begin.ok) return begin;

  try {
    const outcome = await executeRun({
      runId: begin.runId,
      configId: input.configId,
      projectId: input.projectId,
      billingCustomer: input.billingCustomer,
      trigger: input.trigger,
      nameBudget: input.nameBudget ?? {
        spentUsd: 0,
        capUsd: WEEKLY_JEV_CAP_USD,
      },
    });
    return { ok: true, runId: begin.runId, outcome };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "AI visibility check failed";
    await failRunIfActive(begin.runId, message);
    throw error;
  }
}
