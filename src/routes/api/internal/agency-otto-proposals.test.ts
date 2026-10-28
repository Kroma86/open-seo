import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";

const { mockEnv, mocks } = vi.hoisted(() => ({
  mockEnv: {} as { AGENCY_SCORE_EXPORT_TOKEN?: string },
  mocks: {
    resolveProjectByDomain: vi.fn(),
    enqueue: vi.fn(),
    list: vi.fn(),
    markPulled: vi.fn(),
    reject: vi.fn(),
    rejections: vi.fn(),
    inventory: vi.fn(),
  },
}));

vi.mock("cloudflare:workers", () => ({ env: mockEnv }));
vi.mock(
  "@/server/features/agency/ProposalInventoryService",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/server/features/agency/ProposalInventoryService")
      >();
    return {
      ...actual,
      readProposalInventoryPage: (...args: unknown[]) =>
        mocks.inventory(...args),
    };
  },
);
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

vi.mock(
  "@/server/features/agency/ProposalRejectionService",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/server/features/agency/ProposalRejectionService")
      >();
    return {
      ...actual,
      rejectHomegrownOttoProposal: (...args: unknown[]) =>
        mocks.reject(...args),
      getProposalRejections: (...args: unknown[]) => mocks.rejections(...args),
    };
  },
);
vi.mock(
  "@/server/features/agency/repositories/ProposalRejectionsRepository",
  () => ({ ProposalRejectionsRepository: {} }),
);

import { ProposalRejectionError } from "@/server/features/agency/ProposalRejectionService";
import { handleGet, handlePost } from "./agency-otto-proposals";

const TOKEN = "test-export-token";

describe("GET inventory_page (reporting only)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.AGENCY_SCORE_EXPORT_TOKEN = TOKEN;
  });
  const get = (query: string, token = TOKEN) =>
    handleGet(
      new Request(
        "https://example.test/api/internal/agency-otto-proposals?" + query,
        { headers: { authorization: "Bearer " + token } },
      ),
    );
  it("requires the existing agency credential before inventory access", async () => {
    expect((await get("action=inventory_page", "wrong")).status).toBe(401);
    expect(mocks.inventory).not.toHaveBeenCalled();
  });
  it("returns a bound cursor page without touching queue operations", async () => {
    mocks.inventory.mockResolvedValue({
      schema: "otto-inventory-page/1",
      request_cursor: "page2",
      count: 0,
    });
    const response = await get("action=inventory_page&cursor=page2");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.inventory).toHaveBeenCalledWith("page2");
    for (const fn of [
      mocks.enqueue,
      mocks.markPulled,
      mocks.reject,
      mocks.list,
    ])
      expect(fn).not.toHaveBeenCalled();
  });
  it.each([
    "&status=pending",
    "&domain=example.test",
    "&limit=200",
    "&cursor=a&cursor=b",
    "&action=inventory_page",
  ])("rejects scope modifiers %s", async (suffix) => {
    expect((await get("action=inventory_page" + suffix)).status).toBe(400);
    expect(mocks.inventory).not.toHaveBeenCalled();
  });
  it("suppresses raw storage errors", async () => {
    mocks.inventory.mockRejectedValue(new Error("private storage detail"));
    const response = await get("action=inventory_page");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "proposal_inventory_unavailable",
    });
  });
});

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

describe("rejection route boundaries", () => {
  beforeEach(() => {
    mockEnv.AGENCY_SCORE_EXPORT_TOKEN = TOKEN;
    mocks.reject.mockReset();
    mocks.rejections.mockReset();
  });
  it("authenticates before rejection or status lookup", async () => {
    const request = post({ action: "reject" });
    request.headers.delete("authorization");
    expect((await handlePost(request)).status).toBe(401);
    expect(
      (
        await handleGet(
          new Request(
            "http://localhost/api/internal/agency-otto-proposals?action=rejection_status&id=x",
          ),
        )
      ).status,
    ).toBe(401);
    expect(mocks.reject).not.toHaveBeenCalled();
    expect(mocks.rejections).not.toHaveBeenCalled();
  });
  it("unknown explicit actions never fall through into enqueue", async () => {
    for (const action of ["rejet", "enqueue", "", null, 3]) {
      expect(
        (
          await handlePost(
            post({ action, domain: "example.test", fixes: { title: "T" } }),
          )
        ).status,
      ).toBe(400);
    }
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.resolveProjectByDomain).not.toHaveBeenCalled();
  });
  it("routes only the explicit rejection and prevents caching", async () => {
    mocks.reject.mockResolvedValue({ proposalId: "synthetic" });
    const response = await handlePost(
      post({ action: "reject", id: "synthetic" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.reject).toHaveBeenCalledWith({ id: "synthetic" });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.markPulled).not.toHaveBeenCalled();
  });
  it("reports guarded conflicts and uncertain errors without retrying", async () => {
    mocks.reject.mockRejectedValueOnce(
      new ProposalRejectionError("proposal_payload_mismatch", 409),
    );
    expect((await handlePost(post({ action: "reject" }))).status).toBe(409);
    mocks.reject.mockRejectedValueOnce(new Error("private connection details"));
    const uncertain = await handlePost(post({ action: "reject" }));
    expect(uncertain.status).toBe(503);
    expect(await uncertain.json()).toEqual({
      error: "rejection_outcome_unconfirmed",
    });
    expect(mocks.reject).toHaveBeenCalledTimes(2);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("exact-ID recovery lookup is read only and uncached", async () => {
    mocks.rejections.mockResolvedValue([]);
    const request = new Request(
      "http://localhost/api/internal/agency-otto-proposals?action=rejection_status&id=a&id=b",
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const response = await handleGet(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.rejections).toHaveBeenCalledWith(["a", "b"]);
    expect(mocks.reject).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
