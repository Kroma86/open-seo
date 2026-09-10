import {
  enqueueHomegrownOttoProposal,
  listHomegrownOttoProposals,
} from "@/server/features/agency/AgencyOttoProposalsService";
import { type ToolContext } from "@/server/mcp/context";
import { requireProjectForDomain } from "@/server/mcp/tools/domain-project-auth";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { z } from "zod";

export const proposeHomegrownOttoFixesTool = {
  name: "propose_homegrown_otto_fixes",
  config: {
    title: "Propose HomeGrown OTTO fixes",
    description:
      "Queue edge SEO fixes (title/description/og/h1) for HomeGrown OTTO. Writes to the pending proposal queue only — never deploys, never touches client origin files, never bypasses Jon's approval gate. Hermes pulls these into OTTO pending/ for gate.py.",
    inputSchema: {
      domain: z.string().min(1).describe("Client hostname."),
      path: z.string().optional().describe("Page path to fix (default /)."),
      title: z.string().optional().describe("Proposed <title> text."),
      description: z.string().optional().describe("Proposed meta description."),
      og_title: z.string().optional(),
      og_description: z.string().optional(),
      h1: z.string().optional(),
      before_title: z.string().optional(),
      before_description: z.string().optional(),
      rationale: z
        .string()
        .optional()
        .describe("Short why this fix helps (shown in gate review)."),
      human_review: z
        .array(z.string())
        .optional()
        .describe("Items that still need a human before approve."),
    },
    outputSchema: {
      id: z.string(),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: async (
    args: {
      domain: string;
      path?: string;
      title?: string;
      description?: string;
      og_title?: string;
      og_description?: string;
      h1?: string;
      before_title?: string;
      before_description?: string;
      rationale?: string;
      human_review?: string[];
    },
    context: ToolContext,
  ) => {
    // The domain must be one of the caller's own projects; the proposal is
    // stored with that owner so no other organization can see or pull it.
    const { organizationId, project } = await requireProjectForDomain(
      context,
      args.domain,
    );

    const fixes: Record<string, string> = {};
    if (args.title) fixes.title = args.title;
    if (args.description) fixes.description = args.description;
    if (args.og_title) fixes.og_title = args.og_title;
    if (args.og_description) fixes.og_description = args.og_description;
    if (args.h1) fixes.h1 = args.h1;

    const proposal = await enqueueHomegrownOttoProposal({
      domain: args.domain,
      organizationId,
      projectId: project.id,
      path: args.path,
      fixes,
      before: {
        title: args.before_title ?? null,
        description: args.before_description ?? null,
      },
      humanReview: args.human_review ?? [],
      rationale: args.rationale ?? null,
      proposedBy: "sam",
    });

    return mcpResponse({
      text: [
        `Queued HomeGrown OTTO proposal ${proposal.id} for ${proposal.domain}${proposal.path} (project ${project.name}).`,
        "Status: pending — waiting for Hermes pull + Jon's gate. Nothing was deployed.",
        `Fixes: ${Object.keys(proposal.fixes).join(", ")}`,
      ].join("\n"),
      structuredContent: proposal,
    });
  },
};

export const listHomegrownOttoProposalsTool = {
  name: "list_homegrown_otto_proposals",
  config: {
    title: "List HomeGrown OTTO proposals",
    description:
      "List queued HomeGrown OTTO fix proposals (pending/pulled/rejected) for one of your projects' domains. Read-only. Use after propose_homegrown_otto_fixes to confirm the queue.",
    inputSchema: {
      domain: z
        .string()
        .min(1)
        .describe("Hostname of one of your projects (required)."),
      status: z
        .enum(["pending", "pulled", "rejected"])
        .optional()
        .describe("Filter by status (default pending)."),
      limit: z.number().int().min(1).max(100).optional(),
    },
    outputSchema: {
      count: z.number(),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: async (
    args: {
      domain: string;
      status?: "pending" | "pulled" | "rejected";
      limit?: number;
    },
    context: ToolContext,
  ) => {
    const { organizationId } = await requireProjectForDomain(
      context,
      args.domain,
    );
    const proposals = await listHomegrownOttoProposals({
      domain: args.domain,
      status: args.status ?? "pending",
      limit: args.limit,
      visibleToOrganizationId: organizationId,
    });
    return mcpResponse({
      text:
        proposals.length === 0
          ? "No HomeGrown OTTO proposals matched."
          : proposals
              .map(
                (p) =>
                  `- ${p.id} ${p.domain}${p.path} [${p.status}] fixes=${Object.keys(p.fixes).join(",")}`,
              )
              .join("\n"),
      structuredContent: { count: proposals.length, proposals },
    });
  },
};
