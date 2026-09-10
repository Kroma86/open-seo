import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for the Workers KV namespace.
const store = vi.hoisted(() => new Map<string, string>());
vi.mock("cloudflare:workers", () => ({
  env: {
    KV: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    },
  },
}));

import {
  enqueueHomegrownOttoProposal,
  listHomegrownOttoProposals,
} from "./AgencyOttoProposalsService";

describe("HomeGrown OTTO proposals — ownership", () => {
  beforeEach(() => {
    store.clear();
  });

  it("stores the owning organization and project on a proposal", async () => {
    const proposal = await enqueueHomegrownOttoProposal({
      domain: "https://www.client.com/",
      organizationId: "org_a",
      projectId: "proj_a",
      fixes: { title: "New title" },
    });
    expect(proposal.domain).toBe("client.com");
    expect(proposal.organizationId).toBe("org_a");
    expect(proposal.projectId).toBe("proj_a");
  });

  it("org-scoped listing hides another organization's rows on the same domain", async () => {
    await enqueueHomegrownOttoProposal({
      domain: "client.com",
      organizationId: "org_a",
      projectId: "proj_a",
      fixes: { title: "A" },
    });
    await enqueueHomegrownOttoProposal({
      domain: "client.com",
      organizationId: "org_b",
      projectId: "proj_b",
      fixes: { title: "B" },
    });

    const forA = await listHomegrownOttoProposals({
      domain: "client.com",
      visibleToOrganizationId: "org_a",
    });
    expect(forA.map((p) => p.organizationId)).toEqual(["org_a"]);

    const forB = await listHomegrownOttoProposals({
      domain: "client.com",
      visibleToOrganizationId: "org_b",
    });
    expect(forB.map((p) => p.organizationId)).toEqual(["org_b"]);
  });

  it("keeps legacy unowned rows visible to the org that proved the domain is its project", async () => {
    // Legacy row: written before ownership existed.
    await enqueueHomegrownOttoProposal({
      domain: "client.com",
      fixes: { description: "legacy" },
    });
    const rows = await listHomegrownOttoProposals({
      domain: "client.com",
      visibleToOrganizationId: "org_a",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.organizationId).toBeNull();
  });

  it("refuses an empty organization id as the scope (it is not 'unscoped')", async () => {
    await enqueueHomegrownOttoProposal({
      domain: "client.com",
      organizationId: "org_a",
      projectId: "proj_a",
      fixes: { title: "A" },
    });
    await expect(
      listHomegrownOttoProposals({
        domain: "client.com",
        visibleToOrganizationId: "",
      }),
    ).rejects.toThrow(/non-empty/);
  });

  it("refuses an org-scoped listing without a domain (the domain is the proof)", async () => {
    await expect(
      listHomegrownOttoProposals({ visibleToOrganizationId: "org_a" }),
    ).rejects.toThrow(/requires domain/);
  });

  it("unscoped listing (Hermes bearer path) still sees every row", async () => {
    await enqueueHomegrownOttoProposal({
      domain: "client.com",
      organizationId: "org_a",
      projectId: "proj_a",
      fixes: { title: "A" },
    });
    await enqueueHomegrownOttoProposal({
      domain: "other.com",
      organizationId: "org_b",
      projectId: "proj_b",
      fixes: { title: "B" },
    });
    const all = await listHomegrownOttoProposals({});
    expect(all).toHaveLength(2);
  });
});
