import { getAgencyOttoPageInputs } from "@/server/features/agency/AgencyOttoPageInputsService";
import { type ToolContext } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { z } from "zod";

export const getAgencyOttoPageInputsTool = {
  name: "get_agency_otto_page_inputs",
  config: {
    title: "Get HomeGrown OTTO page inputs",
    description:
      "DB-only homepage/page title, meta description, canonical, and H1 signals from the latest OpenSEO site audit for a domain. Uses no credits. Prefer this as the data source for HomeGrown OTTO fix proposals instead of a fresh DataForSEO crawl.",
    inputSchema: {
      domain: z
        .string()
        .min(1)
        .describe("Hostname or URL (www/protocol stripped)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max pages to return (default 25)."),
    },
    outputSchema: {
      domain: z.string(),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: async (
    args: { domain: string; limit?: number },
    context: ToolContext,
  ) => {
    const data = await getAgencyOttoPageInputs({
      domain: args.domain,
      organizationId: context.auth.organizationId,
      limit: args.limit,
    });
    const home = data.homepage;
    const lines = [
      `Domain: ${data.domain}`,
      `Project: ${data.projectId ? `${data.projectName} (${data.projectId})` : "not found"}`,
      `Audit: ${data.auditId ?? "none"} @ ${data.capturedAt ?? "n/a"}`,
      home
        ? `Homepage: ${home.url} title=${JSON.stringify(home.title)} flags=${home.checksFlagged.join(",") || "none"}`
        : "Homepage: none",
      `Pages: ${data.pages.length}`,
    ];
    return mcpResponse({
      text: lines.join("\n"),
      structuredContent: data,
    });
  },
};
