import { listHomegrownOttoProposals } from "@/server/features/agency/AgencyOttoProposalsService";
import { type ToolContext } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import {
  fetchAgencyPixelStatus,
  normalizeOpsDomain,
} from "@/server/mcp/tools/agency-metrics-pixel";
import { z } from "zod";

export {
  fetchAgencyPixelStatus,
  normalizeOpsDomain,
  pickPixelFromAgencyMetrics,
} from "@/server/mcp/tools/agency-metrics-pixel";

export const getNiceseoOpsStatusTool = {
  name: "get_niceseo_ops_status",
  config: {
    title: "Get NiceSEO ops status (OTTO + pixel)",
    description:
      "Read-only HomeGrown OTTO proposal queue counts plus NiceSEO pixel status for a domain. Uses the OpenSEO proposal KV and the agency board metrics API — no credits, no deploy. Call this before answering OTTO/pixel/\"how connected\" questions.",
    inputSchema: {
      domain: z
        .string()
        .min(1)
        .describe("Hostname or URL (www/protocol stripped)."),
    },
    outputSchema: {
      domain: z.string(),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: async (args: { domain: string }, _context: ToolContext) => {
    const domain = normalizeOpsDomain(args.domain);
    const proposals = await listHomegrownOttoProposals({
      domain,
      limit: 200,
    });
    const byStatus = { pending: 0, pulled: 0, rejected: 0 };
    for (const p of proposals) {
      if (p.status in byStatus) {
        byStatus[p.status as keyof typeof byStatus] += 1;
      }
    }
    const latest = proposals.slice(0, 5).map((p) => ({
      id: p.id,
      status: p.status,
      path: p.path,
      proposedAt: p.proposedAt,
      fixes: Object.keys(p.fixes),
    }));

    const metricsUrl = await getOptionalEnvValue("AGENCY_METRICS_URL");
    const token = await getOptionalEnvValue("AGENCY_DASH_TOKEN");
    const pixelFetch = await fetchAgencyPixelStatus(domain, {
      metricsUrl,
      token,
    });
    const structured = {
      domain,
      otto: {
        pending: byStatus.pending,
        pulled: byStatus.pulled,
        rejected: byStatus.rejected,
        total: proposals.length,
        latest,
        note: "Queued proposals are not live until Hermes pull + Jon's gate.",
      },
      pixel: {
        configured: pixelFetch.configured,
        error: pixelFetch.error,
        ...pixelFetch.pixel,
        note: "NiceSEO pixel is separate from public page fetch / DataForSEO / GSC.",
      },
    };

    const lines = [
      `Domain: ${domain}`,
      `HomeGrown OTTO queue: pending=${byStatus.pending} pulled=${byStatus.pulled} rejected=${byStatus.rejected} (total ${proposals.length})`,
    ];
    if (latest.length) {
      lines.push(
        "Latest proposals:",
        ...latest.map(
          (p) =>
            `- ${p.id} [${p.status}] ${p.path} fixes=${p.fixes.join(",") || "none"}`,
        ),
      );
    } else {
      lines.push("Latest proposals: none");
    }
    if (!pixelFetch.configured) {
      lines.push(`NiceSEO pixel: ${pixelFetch.error}`);
    } else if (pixelFetch.error) {
      lines.push(`NiceSEO pixel: error — ${pixelFetch.error}`);
    } else if (!pixelFetch.pixel.found) {
      lines.push("NiceSEO pixel: no board row for this domain");
    } else {
      lines.push(
        `NiceSEO pixel: status=${pixelFetch.pixel.status ?? "unknown"} events_7d=${pixelFetch.pixel.events_7d ?? "n/a"} as_of=${pixelFetch.pixel.as_of ?? "n/a"}`,
      );
    }
    lines.push(
      "Nothing here deploys from chat — OTTO apply stays on Hermes gate.",
    );

    return mcpResponse({
      text: lines.join("\n"),
      structuredContent: structured,
    });
  },
};
