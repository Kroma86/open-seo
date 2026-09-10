import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";
import {
  getAgencyOttoPageInputs,
  getAgencyOttoPageInputsGlobal,
} from "./AgencyOttoPageInputsService";

const mocks = vi.hoisted(() => ({
  resolveProjectByDomain: vi.fn(),
  getLatestAuditForProject: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    }),
  },
}));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  normalizeProjectDomain: (raw: string | null | undefined) => {
    if (raw == null) return null;
    let host = raw.trim().toLowerCase();
    for (const prefix of ["https://", "http://"]) {
      if (host.startsWith(prefix)) host = host.slice(prefix.length);
    }
    if (host.startsWith("www.")) host = host.slice(4);
    host = host.split("/")[0] ?? host;
    return host || null;
  },
  ProjectRepository: {
    resolveProjectByDomain: (...args: unknown[]) =>
      mocks.resolveProjectByDomain(...args),
  },
}));
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {
    getLatestAuditForProject: (...args: unknown[]) =>
      mocks.getLatestAuditForProject(...args),
  },
}));

const PROJECT = {
  id: "p1",
  name: "Client",
  domain: "client.com",
  organizationId: "org1",
  archivedAt: null,
};

describe("getAgencyOttoPageInputs project resolution", () => {
  beforeEach(() => {
    mocks.resolveProjectByDomain.mockReset();
    mocks.getLatestAuditForProject.mockReset();
    mocks.getLatestAuditForProject.mockResolvedValue(null);
  });

  it("resolves by exact domain inside the caller's organization", async () => {
    mocks.resolveProjectByDomain.mockResolvedValue(PROJECT);
    const data = await getAgencyOttoPageInputs({
      domain: "https://www.client.com/about",
      organizationId: "org1",
    });
    expect(mocks.resolveProjectByDomain).toHaveBeenCalledWith({
      domain: "client.com",
      organizationId: "org1",
    });
    expect(data.projectId).toBe("p1");
    expect(data.projectName).toBe("Client");
    expect(data.pages).toEqual([]);
  });

  it("uses the unscoped resolver only for the global (Hermes) export", async () => {
    mocks.resolveProjectByDomain.mockResolvedValue(PROJECT);
    await getAgencyOttoPageInputsGlobal("client.com");
    expect(mocks.resolveProjectByDomain).toHaveBeenCalledWith({
      domain: "client.com",
      organizationId: null,
    });
  });

  it("returns the empty shape (no project id) when the domain resolves to nothing", async () => {
    mocks.resolveProjectByDomain.mockResolvedValue(null);
    const data = await getAgencyOttoPageInputs({ domain: "nobody.example" });
    expect(data).toMatchObject({
      domain: "nobody.example",
      projectId: null,
      projectName: null,
      auditId: null,
      homepage: null,
      pages: [],
    });
    expect(mocks.getLatestAuditForProject).not.toHaveBeenCalled();
  });

  it("surfaces CONFLICT when two projects share the domain", async () => {
    mocks.resolveProjectByDomain.mockRejectedValue(
      new AppError("CONFLICT", "ambiguous_project_domain: 2 projects share client.com"),
    );
    await expect(
      getAgencyOttoPageInputs({ domain: "client.com", organizationId: "org1" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
