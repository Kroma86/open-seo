import { z } from "zod";
import { getBrandLookup } from "@/server/features/ai-search/services/brandLookup";
import { explorePrompt } from "@/server/features/ai-search/services/promptExplorer";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import {
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";
import { resolveMarket } from "@/shared/keyword-locations";
import {
  RESEARCH_SCOPE_PARAM_DESCRIPTION,
  researchScopeSchema,
} from "@/shared/researchScope";
import {
  BRAND_LOOKUP_MAX_INPUT_LENGTH,
  PROMPT_EXPLORER_MAX_PROMPT_LENGTH,
  promptExplorerModelSchema,
} from "@/types/schemas/ai-search";

const BRAND_LOOKUP_MAX_COMPETITORS = 5;

const getAiBrandVisibilityInputSchema = {
  projectId: projectIdSchema,
  query: z
    .string()
    .trim()
    .min(1)
    .max(BRAND_LOOKUP_MAX_INPUT_LENGTH)
    .describe("Brand name or domain to look up in LLM mention indexes."),
  competitors: z
    .array(z.string().trim().min(1).max(BRAND_LOOKUP_MAX_INPUT_LENGTH))
    .max(BRAND_LOOKUP_MAX_COMPETITORS)
    .optional()
    .describe(
      "Optional competitor brands/domains for Share of Voice comparison (max 5).",
    ),
  scope: researchScopeSchema
    .optional()
    .describe(
      `${RESEARCH_SCOPE_PARAM_DESCRIPTION} Ignored for brand-keyword queries.`,
    ),
  locationCode: locationCodeSchema
    .optional()
    .describe(
      "Country-level DataForSEO location code for Google AI Overview. Defaults to the project's market. ChatGPT mentions are always US/en.",
    ),
  languageCode: languageCodeSchema
    .optional()
    .describe(
      "Language for locationCode. Defaults to the project's market language.",
    ),
} as const;

const exploreAiPromptInputSchema = {
  projectId: projectIdSchema,
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(PROMPT_EXPLORER_MAX_PROMPT_LENGTH)
    .describe("The prompt to run across the selected LLM models."),
  models: z
    .array(promptExplorerModelSchema)
    .min(1)
    .max(2)
    .describe(
      "LLM models to query (1-2 per call): chat_gpt, claude, gemini, or perplexity.",
    ),
  highlightBrand: z
    .string()
    .trim()
    .min(1)
    .max(BRAND_LOOKUP_MAX_INPUT_LENGTH)
    .optional()
    .describe(
      "Optional brand name to flag in responses and citations (mention detection).",
    ),
} as const;

type GetAiBrandVisibilityArgs = z.infer<
  z.ZodObject<typeof getAiBrandVisibilityInputSchema>
>;
type ExploreAiPromptArgs = z.infer<
  z.ZodObject<typeof exploreAiPromptInputSchema>
>;

function formatNullableMetric(value: number | null | undefined): string {
  return value == null ? "not measured" : String(value);
}

export const getAiBrandVisibilityTool = {
  name: "get_ai_brand_visibility",
  config: {
    title: "Get AI brand visibility",
    description:
      "Looks up how often a brand or domain is mentioned in ChatGPT and Google AI Overview answers (DataForSEO LLM Mentions). Returns mention counts, share of voice vs optional competitors, top cited sources, and per-platform outcomes. Results are cached 24h; spends DataForSEO credits on cache miss. Prefer reusing data already fetched in this conversation. Never treat an absent metric as 0 — report it as not measured.",
    inputSchema: getAiBrandVisibilityInputSchema,
    outputSchema: {
      source: z.literal("dataforseo_llm_mentions"),
      fetchedAt: z.string(),
      query: z.string(),
      resolvedTarget: z.string(),
      detectedTargetType: z.enum(["domain", "keyword"]),
      scope: researchScopeSchema.nullable(),
      hasData: z.boolean(),
      totalMentions: z.number().nullable(),
      totalAiSearchVolume: z.number().nullable(),
      shareOfVoice: looseObjectOutputSchema.nullable(),
      topCitedSources: z.array(looseObjectOutputSchema),
      perPlatform: z.array(looseObjectOutputSchema),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: GetAiBrandVisibilityArgs, context) => {
      const market = resolveMarket(args, context.project);
      const result = await getBrandLookup(
        {
          projectId: args.projectId,
          query: args.query,
          competitors: args.competitors ?? [],
          scope: args.scope,
          locationCode: market.locationCode,
          languageCode: market.languageCode,
        },
        context.billing,
      );

      const text = [
        `AI brand visibility for ${result.resolvedTarget} (query: ${result.query})`,
        `Fetched at: ${result.fetchedAt}`,
        `Has data: ${result.hasData ? "yes" : "no"}`,
        `Total mentions: ${formatNullableMetric(result.totalMentions)}`,
        `Total AI search volume: ${formatNullableMetric(result.totalAiSearchVolume)}`,
        ...result.perPlatform.map(
          (row) =>
            `${row.platform}: status=${row.status}, mentions=${formatNullableMetric(row.mentions)}, ai search volume=${formatNullableMetric(row.aiSearchVolume)}`,
        ),
        result.shareOfVoice
          ? `Share of voice (${result.shareOfVoice.platforms.join(", ")}): ${result.shareOfVoice.entries
              .map(
                (entry) =>
                  `${entry.label}${entry.isTarget ? " (target)" : ""}=${formatNullableMetric(entry.sharePct)}${entry.sharePct == null ? "" : "%"}`,
              )
              .join("; ")}`
          : "Share of voice: not measured",
        result.topPages.length > 0
          ? `Top cited sources (${result.topPages.length}): ${result.topPages
              .slice(0, 3)
              .map((page) => page.url)
              .filter(Boolean)
              .join(", ")}`
          : "Top cited sources: none found",
      ].join("\n");

      return mcpResponse({
        text,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/brand-lookup`,
          { query: args.query },
        ),
        structuredContent: {
          source: "dataforseo_llm_mentions" as const,
          fetchedAt: result.fetchedAt,
          query: result.query,
          resolvedTarget: result.resolvedTarget,
          detectedTargetType: result.detectedTargetType,
          scope: result.scope,
          hasData: result.hasData,
          totalMentions: result.totalMentions,
          totalAiSearchVolume: result.totalAiSearchVolume,
          shareOfVoice: result.shareOfVoice,
          topCitedSources: result.topPages,
          perPlatform: result.perPlatform,
        },
      });
    },
  ),
};

export const exploreAiPromptTool = {
  name: "explore_ai_prompt",
  config: {
    title: "Explore AI prompt",
    description:
      "Runs one prompt through up to 2 LLM models via DataForSEO (ChatGPT, Claude, Gemini, or Perplexity) and returns each model's answer, brand-mention flags, and citations. Results are cached 7 days; spends DataForSEO credits on cache miss. Prefer reusing data already fetched in this conversation. Cap at 2 models per call.",
    inputSchema: exploreAiPromptInputSchema,
    outputSchema: {
      prompt: z.string(),
      highlightBrand: z.string().nullable(),
      fetchedAt: z.string(),
      results: z.array(looseObjectOutputSchema),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: ExploreAiPromptArgs, context) => {
    const result = await explorePrompt(
      {
        projectId: args.projectId,
        prompt: args.prompt,
        models: args.models,
        // explorePrompt normalizes to null (input.highlightBrand?.trim() || null),
        // matching the nullable() output schema — undefined never reaches it.
        highlightBrand: args.highlightBrand,
        webSearch: true,
      },
      context.billing,
    );

    const text = [
      `Prompt explorer results for: ${result.prompt}`,
      `Fetched at: ${result.fetchedAt}`,
      result.highlightBrand
        ? `Highlight brand: ${result.highlightBrand}`
        : "Highlight brand: none",
      ...result.results.map((row) => {
        if (row.status === "error") {
          return `${row.model}: error — ${row.message}`;
        }
        const mention =
          row.brandMentioned == null
            ? "brand mention not measured"
            : row.brandMentioned
              ? "brand mentioned"
              : "brand not mentioned";
        return `${row.model}: ${mention}; citations=${row.citations.length}; ${row.text.slice(0, 240)}${row.text.length > 240 ? "…" : ""}`;
      }),
    ].join("\n");

    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/prompt-explorer`,
      ),
      structuredContent: {
        prompt: result.prompt,
        highlightBrand: result.highlightBrand,
        fetchedAt: result.fetchedAt,
        results: result.results,
      },
    });
  }),
};
