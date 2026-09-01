import type { BillingCustomerContext } from "@/server/billing/subscription";
import { getBrandLookup } from "@/server/features/ai-search/services/brandLookup";
import { explorePrompt } from "@/server/features/ai-search/services/promptExplorer";
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
import type { BrandLookupResult } from "@/types/schemas/ai-search";
import type { PromptExplorerResult } from "@/types/schemas/ai-search";

type RunDetail = {
  source: "dataforseo_llm_mentions";
  promptsAttempted: number;
  brandLookup: {
    fetchedAt: string;
    totalMentions: number | null;
    partialMentions: boolean;
    shareOfVoicePct: number | null;
    perPlatform: BrandLookupResult["perPlatform"];
    topCitedSources: BrandLookupResult["topPages"];
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
function buildCostNote(input: { promptExplorerCalls: number }): string {
  const brandLabel = "brand lookup cache/paid uncertain";
  if (input.promptExplorerCalls === 0) return brandLabel;
  return `${brandLabel}; ${input.promptExplorerCalls} prompt check(s): cache/paid uncertain`;
}

async function executeRun(input: {
  runId: string;
  configId: string;
  projectId: string;
  billingCustomer: BillingCustomerContext;
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
  const explorerModels = promptExplorerModelsForPlatforms(platforms);
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

  let promptExplorerCalls = 0;

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
  const promptResults: RunDetail["prompts"] = [];
  // Up to 10 prompts, each explorePrompt call isolated in try/catch so one failure
  // cannot abort the run. Worst case ~10 sequential calls still fits inside the
  // 60-minute stale threshold (STALE_AI_VISIBILITY_RUN_MS).
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
      const explorer = await explorePrompt(
        {
          projectId: input.projectId,
          prompt: trackedPrompt.prompt,
          models: explorerModels,
          highlightBrand: config.brand,
          webSearch: true,
        },
        input.billingCustomer,
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

  const filteredPlatformRows = brandLookup.perPlatform.filter((row) =>
    lookupPlatforms.includes(row.platform),
  );
  const mentionsSum = sumMentionsForPlatforms(brandLookup, lookupPlatforms);
  const promptsChecked = countPromptsWithDefinitiveAnswer(promptResults);
  const promptsWithBrand = countPromptsWithBrand(promptResults);

  const detail: RunDetail = {
    source: "dataforseo_llm_mentions",
    promptsAttempted: promptExplorerCalls,
    brandLookup: {
      fetchedAt: brandLookup.fetchedAt,
      totalMentions: mentionsSum.total,
      partialMentions: mentionsSum.partialMentions,
      shareOfVoicePct: targetSharePct(brandLookup),
      perPlatform: filteredPlatformRows,
      topCitedSources: brandLookup.topPages.slice(0, 10),
    },
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
      costNote: buildCostNote({ promptExplorerCalls }),
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
    });
    return { ok: true, runId: begin.runId, outcome };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "AI visibility check failed";
    await failRunIfActive(begin.runId, message);
    throw error;
  }
}
