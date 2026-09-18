import { getAgencyOttoPageInputs } from "@/server/features/agency/AgencyOttoPageInputsService";
import { type ToolContext } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { z } from "zod";

// The handler returns the whole AgencyOttoPageInputs object as
// structuredContent, and the published schema carries
// `additionalProperties: false`. Every field below must therefore be declared:
// while only `domain` was, the tool failed output validation on every call and
// was unusable over MCP.
const ottoPageShape = z.object({
  url: z.string(),
  path: z.string(),
  httpStatus: z.number().nullable(),
  title: z.string().nullable(),
  titleLength: z.number().nullable(),
  description: z.string().nullable(),
  descriptionLength: z.number().nullable(),
  canonical: z.string().nullable(),
  ogTitle: z.string().nullable(),
  ogDescription: z.string().nullable(),
  h1Count: z.number(),
  wordCount: z.number(),
  imagesMissingAlt: z.number(),
  checksFlagged: z.array(z.string()),
});

const ottoPageInputsShape = {
  domain: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  auditId: z.string().nullable(),
  capturedAt: z.string().nullable(),
  source: z.literal("openseo_audit_pages"),
  homepage: ottoPageShape.nullable(),
  homepageReason: z.enum([
    "ok",
    "no_pages_crawled",
    "no_pages_on_project_domain",
    "root_not_in_audit",
  ]),
  pages: z.array(ottoPageShape),
};

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
      ...ottoPageInputsShape,
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
        : `Homepage: none (${data.homepageReason})`,
      `Pages: ${data.pages.length}`,
    ];
    return mcpResponse({
      text: lines.join("\n"),
      structuredContent: data,
    });
  },
};
