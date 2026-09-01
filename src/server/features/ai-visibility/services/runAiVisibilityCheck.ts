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
    results: PromptExplorerResult["results"];
  }>;
};

/** Brand lookup preserves cached fetchedAt; fresh paid calls set fetchedAt to now. */
const BRAND_LOOKUP_FRESH_MS = 5_000;

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

function countSuccessfulPromptChecks(
  promptResults: RunDetail["prompts"],
): number {
  return promptResults.filter((row) =>
    row.results.some((result) => result.status === "success"),
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

function classifyBrandLookupCost(fetchedAt: string): "cache" | "paid" {
  const ageMs = Date.now() - new Date(fetchedAt).getTime();
  return ageMs > BRAND_LOOKUP_FRESH_MS ? "cache" : "paid";
}

function buildCostNote(input: {
  brandLookup: "cache" | "paid";
  promptExplorerCalls: number;
}): string {
  const brandLabel =
    input.brandLookup === "cache"
      ? "brand lookup cache hit"
      : "brand lookup paid";
  if (input.promptExplorerCalls === 0) return brandLabel;
  return `${brandLabel}; ${input.promptExplorerCalls} prompt check(s): cache/paid uncertain`;
}

async function executeRun(input: {
  runId: string;
  configId: string;
  projectId: string;
  billingCustomer: BillingCustomerContext;
}) {
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

  const startedAt = new Date().toISOString();
  await AiVisibilityRepository.updateRun(input.runId, {
    status: "running",
    startedAt,
  });

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
  const brandLookupCost = classifyBrandLookupCost(brandLookup.fetchedAt);

  const promptResults: RunDetail["prompts"] = [];
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
  }

  const filteredPlatformRows = brandLookup.perPlatform.filter((row) =>
    lookupPlatforms.includes(row.platform),
  );
  const mentionsSum = sumMentionsForPlatforms(brandLookup, lookupPlatforms);
  const promptsChecked = countSuccessfulPromptChecks(promptResults);
  const promptsWithBrand = countPromptsWithBrand(promptResults);

  const detail: RunDetail = {
    source: "dataforseo_llm_mentions",
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
  await AiVisibilityRepository.updateRun(input.runId, {
    status: "completed",
    finishedAt,
    totalMentions: detail.brandLookup.totalMentions,
    shareOfVoicePct: detail.brandLookup.shareOfVoicePct,
    promptsWithBrand,
    promptsChecked,
    detail: JSON.stringify(detail),
    costNote: buildCostNote({
      brandLookup: brandLookupCost,
      promptExplorerCalls,
    }),
  });
  await AiVisibilityRepository.updateConfig(input.configId, input.projectId, {
    lastRunAt: finishedAt,
  });
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
    await executeRun({
      runId: begin.runId,
      configId: input.configId,
      projectId: input.projectId,
      billingCustomer: input.billingCustomer,
    });
    return begin;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "AI visibility check failed";
    await failRunIfActive(begin.runId, message);
    throw error;
  }
}
