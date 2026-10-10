import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for the Workers KV namespace.
const store = vi.hoisted(() => new Map<string, string>());
// Counts reads and how many overlap, so tests can see batched parallel reads.
const reads = vi.hoisted(() => ({ calls: 0, inFlight: 0, maxInFlight: 0 }));
vi.mock("cloudflare:workers", () => ({
  env: {
    KV: {
      get: async (key: string) => {
        reads.calls += 1;
        reads.inFlight += 1;
        reads.maxInFlight = Math.max(reads.maxInFlight, reads.inFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        reads.inFlight -= 1;
        return store.get(key) ?? null;
      },
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
      organizationId: null,
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

describe("HomeGrown OTTO proposals — batched reads", () => {
  const statuses = ["pending", "pulled", "rejected"] as const;

  // 60 rows in the index, newest first, statuses cycling; row 7 is missing, row 9 is corrupt.
  function seed() {
    const ids = Array.from(
      { length: 60 },
      (_, i) => `id-${String(i).padStart(2, "0")}`,
    );
    ids.forEach((id, i) => {
      if (i === 7) return;
      store.set(
        `homegrown-otto:proposal:${id}`,
        i === 9
          ? "{not json"
          : JSON.stringify({
              id,
              domain: "client.com",
              status: statuses[i % 3],
              fixes: { title: id },
            }),
      );
    });
    store.set("homegrown-otto:proposal-index", JSON.stringify(ids));
    return ids;
  }

  beforeEach(() => {
    store.clear();
    Object.assign(reads, { calls: 0, inFlight: 0, maxInFlight: 0 });
  });

  it("keeps index order and status filtering across batches", async () => {
    const ids = seed();
    for (const status of statuses) {
      const expected = ids.filter(
        (_, i) => i !== 7 && i !== 9 && statuses[i % 3] === status,
      );
      const got = await listHomegrownOttoProposals({ status, limit: 200 });
      expect(got.map((p) => p.id)).toEqual(expected);
    }
  });

  it("reads in parallel batches of at most 25", async () => {
    seed();
    await listHomegrownOttoProposals({ status: "rejected", limit: 200 });
    expect(reads.maxInFlight).toBeGreaterThan(1);
    expect(reads.maxInFlight).toBeLessThanOrEqual(25);
    expect(reads.calls).toBe(1 + 60); // index + every row
  });

  it("stops reading once the limit is met", async () => {
    seed();
    const got = await listHomegrownOttoProposals({
      status: "pending",
      limit: 2,
    });
    expect(got.map((p) => p.id)).toEqual(["id-00", "id-03"]);
    expect(reads.calls).toBe(1 + 25); // index + one batch
  });
});
