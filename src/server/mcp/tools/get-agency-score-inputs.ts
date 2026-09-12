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
      "Export of rank tracker positions, backlink snapshot referring domains, latest site-audit Lighthouse SEO + issue counts, and GSC/GA4 connection status for a domain. Uses no credits — never calls DataForSEO. Everything is DB-only except one live Search Console totals read (last 28 days) when a GSC property is mapped. GBP is always not_connected_native until a native Google Business login exists. For NiceSEO agency board scoring. Apply niceseo-pillars law: Technical=lighthouseSeoAvg only; Visibility=100−GSC position else rank positions; Content=Not measured; Authority=log referringDomains; missing=Not measured. Never issue-density. Never Search Atlas.",
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
      connections: z.object({
        gsc: z.object({
          connected: z.boolean(),
          siteUrl: z.string().nullable(),
          connectedAt: z.string().nullable(),
        }),
        ga4: z.object({
          connected: z.boolean(),
          propertyId: z.string().nullable(),
          propertyDisplayName: z.string().nullable(),
          connectedAt: z.string().nullable(),
        }),
      }),
      gsc: z
        .object({
          clicks: z.number().nullable(),
          impressions: z.number().nullable(),
          ctr: z.number().nullable(),
          position: z.number().nullable(),
          capturedAt: z.string().nullable(),
          source: z.literal("google_search_console"),
        })
        .nullable(),
      gbp: z.object({
        status: z.enum(["not_connected_native", "dfs_local"]),
        source: z.enum(["dataforseo"]).nullable(),
        capturedAt: z.string().nullable(),
      }),
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
      `GSC: ${data.connections.gsc.connected ? `connected ${data.connections.gsc.siteUrl}` : "not connected"}`,
      `GSC totals (28d): ${
        data.gsc
          ? `clicks=${data.gsc.clicks ?? "n/a"} impressions=${data.gsc.impressions ?? "n/a"} position=${data.gsc.position ?? "n/a"} as of ${data.gsc.capturedAt ?? "unknown"}`
          : "not measured"
      }`,
      `GA4: ${data.connections.ga4.connected ? `connected ${data.connections.ga4.propertyId}` : "not connected"}`,
      `GBP: ${data.gbp.status}`,
      "Pillar law: Technical=lighthouseSeoAvg only; Visibility=max(0,100−GSC position) else rank positions with a number; Content=Not measured; Authority=round(min(99,20*log10(rd+1)*1.5),1); missing=Not measured. Never issue-density. Never Search Atlas.",
    ];
    return mcpResponse({
      text: lines.join("\n"),
      structuredContent: data,
    });
  },
};
