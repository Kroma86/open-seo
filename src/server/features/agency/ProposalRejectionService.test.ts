import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProposalRejection } from "./repositories/ProposalRejectionsRepository";

const state = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  rows: new Map<string, ProposalRejection>(),
  failRead: false,
  beforePut: undefined as (() => Promise<void>) | undefined,
  afterPut: undefined as (() => Promise<void>) | undefined,
}));
const repo = vi.hoisted(() => ({
  findByIds: vi.fn(async (ids: string[]) => {
    if (state.failRead) throw new Error("database_unavailable");
    return ids.flatMap((id) =>
      state.rows.has(id) ? [state.rows.get(id)!] : [],
    );
  }),
  insertIfAbsent: vi.fn(async (row: ProposalRejection) => {
    if (!state.rows.has(row.proposalId))
      state.rows.set(row.proposalId, structuredClone(row));
    return state.rows.get(row.proposalId)!;
  }),
}));
const put = vi.hoisted(() =>
  vi.fn(async (key: string, value: string) => {
    await state.beforePut?.();
    state.kv.set(key, value);
    await state.afterPut?.();
  }),
);
vi.mock("cloudflare:workers", () => ({
  env: {
    KV: {
      get: async (key: string) => state.kv.get(key) ?? null,
      put,
    },
  },
}));
vi.mock("./repositories/ProposalRejectionsRepository", () => ({
  ProposalRejectionsRepository: repo,
}));
import {
  getProposalRejections,
  proposalPayloadHash,
  rejectHomegrownOttoProposal,
} from "./ProposalRejectionService";
import {
  listHomegrownOttoProposals,
  markHomegrownOttoProposalsPulled,
} from "./AgencyOttoProposalsService";

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const key = (value = id) => `homegrown-otto:proposal:${value}`;
function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    domain: "example.test",
    path: "/",
    status: "pending",
    organizationId: "org-a",
    fixes: { title: "Synthetic title" },
    before: { title: "Old synthetic title" },
    unknownProducerField: { array: [1, { status: "payload" }] },
    pulledAt: null,
    ...over,
  };
}
async function seed(over: Record<string, unknown> = {}) {
  const value = record(over);
  state.kv.set(key(), JSON.stringify(value));
  state.kv.set("homegrown-otto:proposal-index", JSON.stringify([id]));
  return {
    id,
    domain: "example.test",
    path: "/",
    expectedPayloadHash: await proposalPayloadHash(value),
    requestId,
    reason: "Synthetic stale-work test",
  };
}
beforeEach(() => {
  state.kv.clear();
  state.rows.clear();
  state.failRead = false;
  state.afterPut = undefined;
  state.beforePut = undefined;
});

describe("exact proposal rejection", () => {
  it("preserves every stored byte and returns the first receipt on same-action replay", async () => {
    const input = await seed();
    const before = new Map(state.kv);
    const first = await rejectHomegrownOttoProposal(input);
    expect(await rejectHomegrownOttoProposal(input)).toEqual(first);
    expect(state.rows.size).toBe(1);
    expect(state.kv).toEqual(before);
    expect(put).not.toHaveBeenCalled();
  });
  it("rejects a pulled record without retracting its original data", async () => {
    const input = await seed({
      status: "pulled",
      pulledAt: "2026-01-01T00:00:00Z",
    });
    expect(await rejectHomegrownOttoProposal(input)).toMatchObject({
      priorStatus: "pulled",
      priorPulledAt: "2026-01-01T00:00:00Z",
    });
    expect(JSON.parse(state.kv.get(key())!).status).toBe("pulled");
  });
  it.each([
    { domain: "different.test" },
    { path: "/different" },
    { expectedPayloadHash: "0".repeat(64) },
    { id: other },
    { reason: "" },
    { requestId: "bad" },
    { ignored: "not allowed" },
  ])(
    "refuses a mismatched or invalid request %j before insertion",
    async (patch) => {
      const input = await seed();
      await expect(
        rejectHomegrownOttoProposal({ ...input, ...patch }),
      ).rejects.toThrow();
      expect(repo.insertIfAbsent).not.toHaveBeenCalled();
    },
  );
  it.each(["null", "[]", "not-json", '{"id":"wrong"}'])(
    "refuses malformed stored record %s",
    async (raw) => {
      const input = await seed();
      state.kv.set(key(), raw);
      await expect(rejectHomegrownOttoProposal(input)).rejects.toThrow();
      expect(repo.insertIfAbsent).not.toHaveBeenCalled();
    },
  );
  it("cannot replace a competing action's receipt", async () => {
    const input = await seed();
    const first = await rejectHomegrownOttoProposal(input);
    await expect(
      rejectHomegrownOttoProposal({ ...input, requestId: other }),
    ).rejects.toThrow("different_action");
    await expect(
      rejectHomegrownOttoProposal({ ...input, reason: "another reason" }),
    ).rejects.toThrow("different_action");
    expect(state.rows.get(id)).toEqual(first);
  });
  it("reconciles by exact IDs without depending on capped index membership", async () => {
    const input = await seed();
    const receipt = await rejectHomegrownOttoProposal(input);
    state.kv.set("homegrown-otto:proposal-index", "[]");
    expect(await getProposalRejections([id, other])).toEqual([receipt]);
    await expect(getProposalRejections(Array(76).fill(id))).rejects.toThrow(
      "invalid_rejection_ids",
    );
    await expect(getProposalRejections([])).rejects.toThrow(
      "invalid_rejection_ids",
    );
  });
});

describe("payload identity", () => {
  it("ignores only top-level lifecycle values and object ordering", async () => {
    const original = record();
    const reordered = Object.fromEntries(Object.entries(original).reverse());
    expect(await proposalPayloadHash(reordered)).toBe(
      await proposalPayloadHash(original),
    );
    expect(
      await proposalPayloadHash({
        ...original,
        status: "pulled",
        pulledAt: "later",
      }),
    ).toBe(await proposalPayloadHash(original));
    expect(
      await proposalPayloadHash({
        ...original,
        unknownProducerField: { array: [1, { status: "changed" }] },
      }),
    ).not.toBe(await proposalPayloadHash(original));
    expect(
      await proposalPayloadHash({ ...original, fixes: { title: "changed" } }),
    ).not.toBe(await proposalPayloadHash(original));
    expect(await proposalPayloadHash({ ...original, newKey: null })).not.toBe(
      await proposalPayloadHash(original),
    );
  });
});

describe("all queue readers honor rejection", () => {
  it("overlays before filtering without exposing receipt fields in proposal output", async () => {
    const input = await seed();
    await rejectHomegrownOttoProposal(input);
    expect(await listHomegrownOttoProposals({ status: "pending" })).toEqual([]);
    expect(await listHomegrownOttoProposals({ status: "pulled" })).toEqual([]);
    const [row] = await listHomegrownOttoProposals({ status: "rejected" });
    expect(row.id).toBe(id);
    expect(row).not.toHaveProperty("requestId");
    expect(
      await listHomegrownOttoProposals({
        status: "rejected",
        domain: "example.test",
        visibleToOrganizationId: "org-b",
      }),
    ).toEqual([]);
    expect(await markHomegrownOttoProposalsPulled([id])).toBe(0);
    expect(put).not.toHaveBeenCalled();
  });
  it("fails closed when the rejection store is unavailable", async () => {
    await seed();
    state.failRead = true;
    await expect(listHomegrownOttoProposals()).rejects.toThrow(
      "database_unavailable",
    );
    await expect(markHomegrownOttoProposalsPulled([id])).rejects.toThrow(
      "database_unavailable",
    );
    expect(put).not.toHaveBeenCalled();
  });
  it("a lifecycle write arriving after rejection cannot revive work", async () => {
    const input = await seed();
    state.beforePut = async () => {
      await rejectHomegrownOttoProposal(input);
    };
    expect(await markHomegrownOttoProposalsPulled([id])).toBe(0);
    expect(JSON.parse(state.kv.get(key())!).status).toBe("pulled");
    expect(await listHomegrownOttoProposals({ status: "pending" })).toEqual([]);
    expect(await listHomegrownOttoProposals({ status: "pulled" })).toEqual([]);
    expect(
      (await listHomegrownOttoProposals({ status: "rejected" }))[0].id,
    ).toBe(id);
  });
  it("blocks a rejected record whose immutable payload changes", async () => {
    await rejectHomegrownOttoProposal(await seed());
    state.kv.set(key(), JSON.stringify(record({ fixes: { title: "new" } })));
    await expect(
      listHomegrownOttoProposals({ status: "pending" }),
    ).rejects.toThrow("payload_changed");
  });
  it("does not accept another ID's body in the requested storage slot", async () => {
    await seed();
    state.kv.set(key(), JSON.stringify(record({ id: other })));
    expect(await listHomegrownOttoProposals()).toEqual([]);
    expect(await markHomegrownOttoProposalsPulled([id])).toBe(0);
    expect(put).not.toHaveBeenCalled();
  });
});
