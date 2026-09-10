import { listHomegrownOttoProposals } from "@/server/features/agency/AgencyOttoProposalsService";
import { type ToolContext } from "@/server/mcp/context";
import { requireProjectForDomain } from "@/server/mcp/tools/domain-project-auth";
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
      "Read-only HomeGrown OTTO proposal queue counts plus NiceSEO pixel status for a domain. Uses the OpenSEO proposal KV and the agency board metrics API — no credits, no deploy. Call this before answering OTTO/pixel/\"how connected\" questions. Served field names show what is available to the pixel, not proof that the current values were applied in a browser. Compare the actual current value and pending proposals before deciding whether a field needs improvement; coverage alone does not make a whole page complete.",
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
  handler: async (args: { domain: string }, context: ToolContext) => {
    const domain = normalizeOpsDomain(args.domain);
    // Only the caller's own project domains; other organizations' queues and
    // pixel rows are never shown here.
    const { organizationId } = await requireProjectForDomain(context, domain);
    const proposals = await listHomegrownOttoProposals({
      domain,
      limit: 200,
      visibleToOrganizationId: organizationId,
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
        note: "Queued proposals are not live until Hermes pulls them and the configured quality and approval checks pass.",
      },
      pixel: {
        configured: pixelFetch.configured,
        error: pixelFetch.error,
        ...pixelFetch.pixel,
        applicationVerified: false,
        note: "Served fields are available to the pixel. This feed does not prove that each current value was applied in a browser; aggregate events are not unique fix confirmations.",
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
      const servedFixKeys = pixelFetch.pixel.served_fix_keys;
      const servedFixPaths = pixelFetch.pixel.served_fix_paths;
      const pathEntries = Object.entries(servedFixPaths).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      if (pathEntries.length) {
        if (servedFixKeys.length) {
          lines.push(
            `NiceSEO pixel: fields currently served: ${servedFixKeys.join(", ")}`,
          );
        }
        lines.push(
          `NiceSEO pixel: fields currently served per path: ${pathEntries
            .map(([path, keys]) => `${path}: ${keys.join(", ")}`)
            .join("; ")}`,
        );
      } else if (servedFixKeys.length) {
        lines.push(
          `NiceSEO pixel: fields currently served (per-path detail unavailable): ${servedFixKeys.join(", ")} — verify current values and pending proposals before proposing a replacement`,
        );
      } else {
        lines.push("NiceSEO pixel: fields currently served: none reported");
      }
    }
    lines.push(
      "Browser application of the current served values is not verified by this feed. Served coverage does not mean a whole page is complete.",
      "Nothing here deploys from chat — OTTO apply stays on Hermes gate.",
    );

    return mcpResponse({
      text: lines.join("\n"),
      structuredContent: structured,
    });
  },
};
