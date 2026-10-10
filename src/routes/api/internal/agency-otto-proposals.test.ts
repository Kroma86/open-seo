import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";

const { mockEnv, mocks } = vi.hoisted(() => ({
  mockEnv: {} as { AGENCY_SCORE_EXPORT_TOKEN?: string },
  mocks: {
    resolveProjectByDomain: vi.fn(),
    enqueue: vi.fn(),
    list: vi.fn(),
    markPulled: vi.fn(),
  },
}));

vi.mock("cloudflare:workers", () => ({ env: mockEnv }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
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
  markHomegrownOttoProposalsPulled: (...args: unknown[]) =>
    mocks.markPulled(...args),
}));

import { handlePost } from "./agency-otto-proposals";

const TOKEN = "test-export-token";

function post(body: unknown): Request {
  return new Request("http://localhost/api/internal/agency-otto-proposals", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/internal/agency-otto-proposals (Hermes bearer path)", () => {
  beforeEach(() => {
    mockEnv.AGENCY_SCORE_EXPORT_TOKEN = TOKEN;
    mocks.resolveProjectByDomain.mockReset();
    mocks.enqueue.mockReset();
    mocks.enqueue.mockImplementation(
      async (input: Record<string, unknown>) => ({
        id: "prop_1",
        ...input,
      }),
    );
  });

  it("attaches the owner when the domain resolves to exactly one project", async () => {
    mocks.resolveProjectByDomain.mockResolvedValue({
      id: "proj_a",
      organizationId: "org_a",
      domain: "client.com",
    });
    const response = await handlePost(
      post({ domain: "client.com", fixes: { title: "T" } }),
    );
    expect(response.status).toBe(201);
    expect(mocks.resolveProjectByDomain).toHaveBeenCalledWith({
      domain: "client.com",
      organizationId: null,
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_a",
        projectId: "proj_a",
        proposedBy: "api",
      }),
    );
  });

  it("returns 409 and stores nothing when two projects share the domain", async () => {
    mocks.resolveProjectByDomain.mockRejectedValue(
      new AppError(
        "CONFLICT",
        "ambiguous_project_domain: 2 projects share client.com",
      ),
    );
    const response = await handlePost(
      post({ domain: "client.com", fixes: { title: "T" } }),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "ambiguous_project_domain",
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("returns 500 and stores nothing when the resolver fails for another reason", async () => {
    mocks.resolveProjectByDomain.mockRejectedValue(new Error("db down"));
    const response = await handlePost(
      post({ domain: "client.com", fixes: { title: "T" } }),
    );
    expect(response.status).toBe(500);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("stores an unowned row only when no project has the domain", async () => {
    mocks.resolveProjectByDomain.mockResolvedValue(null);
    const response = await handlePost(
      post({ domain: "nobody.example", fixes: { title: "T" } }),
    );
    expect(response.status).toBe(201);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: null, projectId: null }),
    );
  });
});
