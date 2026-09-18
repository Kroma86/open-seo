import { describe, expect, it, vi } from "vitest";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { getNiceseoOpsStatusTool } from "./get-niceseo-ops-status";
import {
  listHomegrownOttoProposalsTool,
  proposeHomegrownOttoFixesTool,
} from "./homegrown-otto-tools";

// Both tool modules import the proposals service, which imports
// "cloudflare:workers" at module load -- that module only exists inside the
// Workers runtime, so the import throws under vitest's node pool. The sibling
// get-niceseo-ops-status.test.ts mocks it the same way. Nothing here calls the
// service; these tests only read declared schemas.
vi.mock("@/server/features/agency/AgencyOttoProposalsService", () => ({
  listHomegrownOttoProposals: vi.fn(async () => []),
  enqueueHomegrownOttoProposal: vi.fn(async () => ({})),
  markHomegrownOttoProposalsPulled: vi.fn(async () => []),
}));

/**
 * These three tools returned structuredContent carrying keys their outputSchema
 * never declared, so every call failed with "data must NOT have additional
 * properties" and the whole OTTO/pixel surface was unreachable.
 *
 * The check below is the one that matters, and it is NOT what
 * `z.object(shape).safeParse(payload)` does: zod silently STRIPS unknown keys,
 * so a naive schema test passes against the broken code. What actually runs is
 * the server publishing the schema through toJsonSchemaCompat (which emits
 * additionalProperties:false) and the client validating structuredContent
 * against that JSON Schema. This helper reproduces exactly that path, so a
 * handler that grows a field without declaring it fails here, not in
 * production.
 */
function validateAsClientWould(outputSchema: unknown, payload: unknown) {
  const normalized = normalizeObjectSchema(outputSchema as never);
  const published = toJsonSchemaCompat(normalized as never, {
    strictUnions: true,
    pipeStrategy: "output",
  });
  return new AjvJsonSchemaValidator().getValidator(published as never)(payload);
}

const proposal = {
  id: "11111111-2222-4333-8444-555555555555",
  domain: "coachingwithkym.com",
  projectId: null,
  status: "pending" as const,
  proposedAt: "2026-09-17T23:00:00.000Z",
  proposedBy: "mcp" as const,
  path: "/",
  fixes: { title: "New title", h1: "New h1" },
  before: { title: "Old title", description: null },
  humanReview: ["check tone"],
  flags: ["source:openseo_sam"],
  rationale: "CTR fell after the last change",
  pulledAt: null,
};

const ottoSection = {
  pending: 1,
  pulled: 0,
  rejected: 0,
  total: 1,
  latest: [
    {
      id: proposal.id,
      status: "pending",
      path: "/",
      proposedAt: proposal.proposedAt,
      fixes: ["title", "h1"],
    },
  ],
  note: "Queued proposals are not live until Hermes pulls them.",
};

describe("HomeGrown OTTO tool output schemas", () => {
  it("get_niceseo_ops_status: handler payload survives client validation", () => {
    const result = validateAsClientWould(
      getNiceseoOpsStatusTool.config.outputSchema,
      {
        domain: "coachingwithkym.com",
        otto: ottoSection,
        pixel: {
          configured: true,
          error: null,
          found: true,
          status: "ok",
          events_7d: 1234,
          as_of: "2026-09-17",
          served_fix_keys: ["h1"],
          served_fix_paths: { "/": ["h1"] },
        },
      },
    );
    expect(result).toMatchObject({ valid: true });
  });

  it("get_niceseo_ops_status: pixel stays open to new metrics-feed fields", () => {
    // The handler spreads ...pixelFetch.pixel, so the pixel section is declared
    // as an open record on purpose. A field added upstream must not break the
    // tool the way the undeclared top-level keys did.
    const result = validateAsClientWould(
      getNiceseoOpsStatusTool.config.outputSchema,
      {
        domain: "example.com",
        otto: { pending: 0, pulled: 0, rejected: 0, total: 0, latest: [], note: "n" },
        pixel: { configured: false, error: "not configured", addedUpstreamLater: 42 },
      },
    );
    expect(result).toMatchObject({ valid: true });
  });

  it("propose_homegrown_otto_fixes: the returned proposal survives validation", () => {
    const result = validateAsClientWould(
      proposeHomegrownOttoFixesTool.config.outputSchema,
      proposal,
    );
    expect(result).toMatchObject({ valid: true });
  });

  it("list_homegrown_otto_proposals: count plus proposals survives validation", () => {
    const result = validateAsClientWould(
      listHomegrownOttoProposalsTool.config.outputSchema,
      { count: 1, proposals: [proposal] },
    );
    expect(result).toMatchObject({ valid: true });
  });

  // Production, 2026-09-18: four of eighteen pending rows carried this. It was
  // never in the declared type, so every list call failed the client's schema
  // check while the text payload looked fine.
  it("list_homegrown_otto_proposals: a proposal carrying organizationId validates", () => {
    const result = validateAsClientWould(
      listHomegrownOttoProposalsTool.config.outputSchema,
      { count: 1, proposals: [{ ...proposal, organizationId: "org_abc" }] },
    );
    expect(result).toMatchObject({ valid: true });
  });

  it("list_homegrown_otto_proposals: organizationId is optional, not required", () => {
    const result = validateAsClientWould(
      listHomegrownOttoProposalsTool.config.outputSchema,
      { count: 1, proposals: [proposal] },
    );
    expect(result).toMatchObject({ valid: true });
  });

  it("list_homegrown_otto_proposals: organizationId may be null", () => {
    const result = validateAsClientWould(
      listHomegrownOttoProposalsTool.config.outputSchema,
      { count: 1, proposals: [{ ...proposal, organizationId: null }] },
    );
    expect(result).toMatchObject({ valid: true });
  });
});

describe("the check above is not vacuous", () => {
  // Without these, the suite would pass against the broken schemas too: the
  // obvious `z.object(shape).safeParse(payload)` strips unknown keys instead of
  // rejecting them, which is how the original bug reached production with tests
  // green. These assert the validator really does reject what MCP rejects.
  it("rejects an undeclared top-level key", () => {
    const result = validateAsClientWould(
      listHomegrownOttoProposalsTool.config.outputSchema,
      { count: 1, proposals: [proposal], undeclaredKey: "boom" },
    );
    expect(result).toMatchObject({ valid: false });
    expect(JSON.stringify(result)).toContain("must NOT have additional properties");
  });

  it("rejects an undeclared key nested inside a proposal", () => {
    const result = validateAsClientWould(
      proposeHomegrownOttoFixesTool.config.outputSchema,
      { ...proposal, undeclaredKey: "boom" },
    );
    expect(result).toMatchObject({ valid: false });
  });

  it("rejects a payload missing a required field", () => {
    const result = validateAsClientWould(
      listHomegrownOttoProposalsTool.config.outputSchema,
      { proposals: [proposal] },
    );
    expect(result).toMatchObject({ valid: false });
  });
});
