import { getAgencyScoreInputs } from "@/server/features/agency/AgencyScoreInputsService";
import { type ToolContext } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { z } from "zod";

const keywordSchema = z.object({
  keyword: z.string(),
  position: z.number().nullable(),
  device: z.string(),
  url: z.string().nullable(),
});

export const getAgencyScoreInputsTool = {
  name: "get_agency_score_inputs",
  config: {
    title: "Get agency score inputs",
    description:
      "DB-only export of rank tracker positions, backlink snapshot referring domains, and latest site-audit Lighthouse SEO + issue counts for a domain. Uses no credits — never calls DataForSEO. For NiceSEO agency board scoring. Prefer this over live DFS pulls when OpenSEO already has fresh cached data.",
    inputSchema: {
      domain: z
        .string()
        .min(1)
        .describe(
          "Hostname or URL to resolve to an OpenSEO project (www/protocol stripped).",
        ),
    },
    outputSchema: {
      domain: z.string(),
      projectId: z.string().nullable(),
      projectName: z.string().nullable(),
      ranks: z
        .object({
          capturedAt: z.string().nullable(),
          keywords: z.array(keywordSchema),
          source: z.literal("openseo_rank_tracker"),
        })
        .nullable(),
      backlinks: z
        .object({
          capturedAt: z.string().nullable(),
          referringDomains: z.number().nullable(),
          backlinks: z.number().nullable(),
          rank: z.number().nullable(),
          source: z.literal("openseo_backlink_snapshot"),
        })
        .nullable(),
      audit: z
        .object({
          capturedAt: z.string().nullable(),
          status: z.string().nullable(),
          pagesCrawled: z.number().nullable(),
          issueCount: z.number().nullable(),
          lighthouseSeoAvg: z.number().nullable(),
          source: z.literal("openseo_audit"),
        })
        .nullable(),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: async (args: { domain: string }, context: ToolContext) => {
    const data = await getAgencyScoreInputs({
      domain: args.domain,
      organizationId: context.auth.organizationId,
    });
    const lines = [
      `Domain: ${data.domain}`,
      `Project: ${data.projectId ? `${data.projectName} (${data.projectId})` : "not found"}`,
      `Ranks: ${data.ranks ? `${data.ranks.keywords.length} keywords @ ${data.ranks.capturedAt ?? "unknown"}` : "none"}`,
      `Backlinks: ${data.backlinks ? `rd=${data.backlinks.referringDomains} @ ${data.backlinks.capturedAt ?? "unknown"}` : "none"}`,
      `Audit: ${data.audit ? `seo=${data.audit.lighthouseSeoAvg} issues=${data.audit.issueCount} pages=${data.audit.pagesCrawled}` : "none"}`,
    ];
    return mcpResponse({
      text: lines.join("\n"),
      structuredContent: data,
    });
  },
};
