import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";
import type { ToolContext } from "@/server/mcp/context";
import {
  listHomegrownOttoProposalsTool,
  proposeHomegrownOttoFixesTool,
} from "./homegrown-otto-tools";

const mocks = vi.hoisted(() => ({
  resolveProjectByDomain: vi.fn(),
  enqueue: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: {
    resolveProjectByDomain: (...args: unknown[]) =>
      mocks.resolveProjectByDomain(...args),
  },
}));
vi.mock("@/server/features/agency/AgencyOttoProposalsService", () => ({
  enqueueHomegrownOttoProposal: (...args: unknown[]) => mocks.enqueue(...args),
  listHomegrownOttoProposals: (...args: unknown[]) => mocks.list(...args),
}));

const context = {
  auth: {
    userId: "u1",
    userEmail: "u1@example.com",
    organizationId: "org_a",
    scopes: [],
    clientId: null,
    baseUrl: "https://seo.example",
  },
} satisfies ToolContext;

const PROJECT = {
  id: "proj_a",
  name: "Client A",
  domain: "client.com",
  organizationId: "org_a",
};

describe("propose_homegrown_otto_fixes", () => {
  beforeEach(() => {
    mocks.resolveProjectByDomain.mockReset();
    mocks.enqueue.mockReset();
    mocks.enqueue.mockImplementation(
      async (input: Record<string, unknown>) => ({
        id: "prop_1",
        domain: "client.com",
        path: "/",
        fixes: input.fixes,
        ...input,
      }),
    );
  });

  it("refuses a domain that is not one of the caller's projects (FORBIDDEN), nothing queued", async () => {
    mocks.resolveProjectByDomain.mockResolvedValue(null);
    await expect(
      proposeHomegrownOttoFixesTool.handler(
        { domain: "someone-else.com", title: "X" },
        context,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("refuses a token with no organization before any lookup", async () => {
    mocks.resolveProjectByDomain.mockResolvedValue(PROJECT);
    await expect(
      proposeHomegrownOttoFixesTool.handler(
        { domain: "client.com", title: "X" },
        { auth: { ...context.auth, organizationId: "" } },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.resolveProjectByDomain).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("surfaces CONFLICT when two projects share the domain, nothing queued", async () => {
    mocks.resolveProjectByDomain.mockRejectedValue(
      new AppError(
        "CONFLICT",
        "ambiguous_project_domain: 2 projects share client.com",
      ),
    );
    await expect(
      proposeHomegrownOttoFixesTool.handler(
        { domain: "client.com", title: "X" },
        context,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("resolves inside the caller's org and stores org + project on the proposal", async () => {
    mocks.resolveProjectByDomain.mockResolvedValue(PROJECT);
    await proposeHomegrownOttoFixesTool.handler(
      { domain: "client.com", title: "Better title" },
      context,
    );
    expect(mocks.resolveProjectByDomain).toHaveBeenCalledWith({
      domain: "client.com",
      organizationId: "org_a",
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "client.com",
        organizationId: "org_a",
        projectId: "proj_a",
        fixes: { title: "Better title" },
      }),
    );
  });
});

describe("list_homegrown_otto_proposals", () => {
  beforeEach(() => {
    mocks.resolveProjectByDomain.mockReset();
    mocks.list.mockReset();
    mocks.list.mockResolvedValue([]);
  });

  it("refuses a domain outside the caller's org", async () => {
    mocks.resolveProjectByDomain.mockResolvedValue(null);
    await expect(
      listHomegrownOttoProposalsTool.handler({ domain: "other.com" }, context),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("lists only rows visible to the caller's org for its own domain", async () => {
    mocks.resolveProjectByDomain.mockResolvedValue(PROJECT);
    await listHomegrownOttoProposalsTool.handler(
      { domain: "client.com" },
      context,
    );
    expect(mocks.list).toHaveBeenCalledWith({
      domain: "client.com",
      status: "pending",
      limit: undefined,
      visibleToOrganizationId: "org_a",
    });
  });
});
