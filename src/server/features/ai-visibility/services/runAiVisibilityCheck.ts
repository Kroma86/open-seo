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
import type { BrandLookupResult } from "@/types/schemas/ai-search";
import type { PromptExplorerResult } from "@/types/schemas/ai-search";

type RunDetail = {
  source: "dataforseo_llm_mentions";
  brandLookup: {
    fetchedAt: string;
    totalMentions: number | null;
    shareOfVoicePct: number | null;
    perPlatform: BrandLookupResult["perPlatform"];
    topCitedSources: BrandLookupResult["topPages"];
  };
  prompts: Array<{
    promptId: string;
    prompt: string;
    fetchedAt: string;
    results: PromptExplorerResult["results"];
  }>;
};

function sumMentionsForPlatforms(
  brandLookup: BrandLookupResult,
  platforms: ReturnType<typeof brandLookupPlatforms>,
): number | null {
  const rows = brandLookup.perPlatform.filter((row) =>
    platforms.includes(row.platform),
  );
  if (rows.length === 0) return null;
  if (rows.every((row) => row.mentions == null)) return null;
  return rows.reduce((sum, row) => sum + (row.mentions ?? 0), 0);
}

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

function buildCostNote(input: {
  brandPaid: boolean;
  promptPaidCount: number;
  promptCacheHitCount: number;
}): string {
  const parts: string[] = [];
  parts.push(input.brandPaid ? "brand lookup paid" : "brand lookup cache hit");
  if (input.promptPaidCount + input.promptCacheHitCount > 0) {
    parts.push(
      `${input.promptCacheHitCount} prompt cache hit(s), ${input.promptPaidCount} prompt paid`,
    );
  }
  return parts.join("; ");
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

  let brandPaid = false;
  let promptPaidCount = 0;
  let promptCacheHitCount = 0;

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
  // Heuristic: a fresh paid call sets fetchedAt to now; cached entries are older.
  brandPaid =
    Date.now() - new Date(brandLookup.fetchedAt).getTime() < 5_000;

  const promptResults: RunDetail["prompts"] = [];
  for (const trackedPrompt of activePrompts) {
    if (explorerModels.length === 0) {
      promptResults.push({
        promptId: trackedPrompt.id,
        prompt: trackedPrompt.prompt,
        fetchedAt: new Date().toISOString(),
        results: [],
      });
      continue;
    }

    const beforeMs = Date.now();
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
    const fresh = Date.now() - new Date(explorer.fetchedAt).getTime() < 5_000;
    if (fresh && Date.now() - beforeMs > 100) {
      promptPaidCount += 1;
    } else {
      promptCacheHitCount += 1;
    }
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
  const promptsWithBrand = promptResults.filter(
    (row) => promptRowMentionsBrand(row.results) === true,
  ).length;

  const detail: RunDetail = {
    source: "dataforseo_llm_mentions",
    brandLookup: {
      fetchedAt: brandLookup.fetchedAt,
      totalMentions: sumMentionsForPlatforms(brandLookup, lookupPlatforms),
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
    promptsWithBrand: activePrompts.length > 0 ? promptsWithBrand : null,
    promptsChecked: activePrompts.length > 0 ? activePrompts.length : null,
    detail: JSON.stringify(detail),
    costNote: buildCostNote({
      brandPaid,
      promptPaidCount,
      promptCacheHitCount,
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
