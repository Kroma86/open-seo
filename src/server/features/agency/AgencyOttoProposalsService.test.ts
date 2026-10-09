import { beforeEach, describe, expect, it, vi } from "vitest";

// The KV rows these tests feed are real shapes taken from production on
// 2026-09-18, not invented ones. See the `organizationId` case below.
const store = new Map<string, string>();
// Counts reads and how many overlap, so tests can see batched parallel reads.
const reads = { calls: 0, inFlight: 0, maxInFlight: 0 };

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
      put: async (key: string, value: string) => void store.set(key, value),
    },
  },
}));

const { listHomegrownOttoProposals, markHomegrownOttoProposalsPulled } =
  await import("./AgencyOttoProposalsService");

const INDEX_KEY = "homegrown-otto:proposal-index";
const key = (id: string) => `homegrown-otto:proposal:${id}`;

function seed(rows: Record<string, unknown>[]) {
  store.clear();
  store.set(INDEX_KEY, JSON.stringify(rows.map((r) => r.id as string)));
  for (const row of rows) store.set(key(row.id as string), JSON.stringify(row));
}

const base = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  domain: "millcreekbakery.ca",
  projectId: "2b5ac25f-7cd3-4689-bae2-fd4fa4e34783",
  status: "pending",
  proposedAt: "2026-09-11T20:03:00.000Z",
  proposedBy: "api",
  path: "/",
  fixes: { title: "Mill Creek Bakery" },
  before: { title: "Home" },
  humanReview: [],
  flags: ["source:openseo_sam"],
  rationale: null,
  pulledAt: null,
  ...over,
});

beforeEach(() => store.clear());

describe("listHomegrownOttoProposals", () => {
  it("returns a plain row unchanged", async () => {
    seed([base()]);
    const [row] = await listHomegrownOttoProposals();
    expect(row).toMatchObject({ id: "p1", domain: "millcreekbakery.ca" });
    expect(row.organizationId).toBeUndefined();
  });

  // Four of eighteen pending rows carried this on 2026-09-18. It is written by
  // the agency API path and was never in the declared type, so every
  // list_homegrown_otto_proposals call failed the client's schema check.
  it("keeps organizationId when the stored row has one", async () => {
    seed([base({ organizationId: "org_abc" })]);
    const [row] = await listHomegrownOttoProposals();
    expect(row.organizationId).toBe("org_abc");
  });

  // The durable half of the fix. A schema cannot keep pace with a KV store that
  // has several producers, so the read path returns the declared shape and
  // nothing else.
  it("drops a key the declared shape does not know about", async () => {
    seed([base({ someFutureField: "boom", anotherOne: 42 })]);
    const [row] = await listHomegrownOttoProposals();
    expect(Object.keys(row)).not.toContain("someFutureField");
    expect(Object.keys(row)).not.toContain("anotherOne");
    expect(row.id).toBe("p1");
  });

  it("fills the gaps in a partial row rather than emitting undefined fields", async () => {
    seed([{ id: "p2", domain: "example.ca" }]);
    const [row] = await listHomegrownOttoProposals();
    expect(row).toMatchObject({
      id: "p2",
      domain: "example.ca",
      projectId: null,
      status: "pending",
      fixes: {},
      humanReview: [],
      flags: [],
      pulledAt: null,
    });
  });

  it("skips a row with no usable identity instead of returning a broken one", async () => {
    seed([{ nonsense: true, id: "p3" } as never, base({ id: "p4" })]);
    const rows = await listHomegrownOttoProposals();
    expect(rows.map((r) => r.id)).toEqual(["p4"]);
  });

  it("filters by status and domain", async () => {
    seed([
      base({ id: "a", status: "pending", domain: "one.ca" }),
      base({ id: "b", status: "pulled", domain: "one.ca" }),
      base({ id: "c", status: "pending", domain: "two.ca" }),
    ]);
    expect((await listHomegrownOttoProposals({ status: "pulled" })).map((r) => r.id))
      .toEqual(["b"]);
    expect((await listHomegrownOttoProposals({ domain: "https://www.two.ca/x" })).map((r) => r.id))
      .toEqual(["c"]);
  });
});

describe("markHomegrownOttoProposalsPulled", () => {
  // Storage keeps everything; only the read path narrows. If the pull path
  // normalized too, a field the API does not declare would be erased from KV
  // the first time a proposal was pulled.
  it("round-trips an undeclared key back into storage", async () => {
    seed([base({ organizationId: "org_abc", someFutureField: "keep me" })]);
    await markHomegrownOttoProposalsPulled(["p1"]);
    const stored = JSON.parse(store.get(key("p1")) as string);
    expect(stored.someFutureField).toBe("keep me");
    expect(stored.organizationId).toBe("org_abc");
    expect(stored.status).toBe("pulled");
    expect(stored.pulledAt).toEqual(expect.any(String));
  });
});

describe("the checks above are not vacuous", () => {
  it("the fixture really carries the undeclared key before the read narrows it", async () => {
    seed([base({ someFutureField: "boom" })]);
    const raw = JSON.parse(store.get(key("p1")) as string);
    expect(raw.someFutureField).toBe("boom");
    const [row] = await listHomegrownOttoProposals();
    expect(row).not.toHaveProperty("someFutureField");
  });

  it("an empty store yields an empty list, so a passing filter test means something", async () => {
    store.clear();
    expect(await listHomegrownOttoProposals()).toEqual([]);
  });
});

describe("HomeGrown OTTO proposals - batched reads", () => {
  const statuses = ["pending", "pulled", "rejected"] as const;

  // 60 rows in the index, newest first, statuses cycling; row 7 is missing, row 9 is corrupt.
  function seedMany() {
    store.clear();
    const ids = Array.from({ length: 60 }, (_, i) => `id-${String(i).padStart(2, "0")}`);
    ids.forEach((id, i) => {
      if (i === 7) return;
      store.set(key(id), i === 9 ? "{not json" : JSON.stringify(base({ id, status: statuses[i % 3] })));
    });
    store.set(INDEX_KEY, JSON.stringify(ids));
    Object.assign(reads, { calls: 0, inFlight: 0, maxInFlight: 0 });
    return ids;
  }

  it("keeps index order and status filtering across batches", async () => {
    const ids = seedMany();
    for (const status of statuses) {
      const expected = ids.filter((_, i) => i !== 7 && i !== 9 && statuses[i % 3] === status);
      const got = await listHomegrownOttoProposals({ status, limit: 200 });
      expect(got.map((p) => p.id)).toEqual(expected);
    }
  });

  it("reads in parallel batches of at most 25", async () => {
    seedMany();
    await listHomegrownOttoProposals({ status: "rejected", limit: 200 });
    expect(reads.maxInFlight).toBeGreaterThan(1);
    expect(reads.maxInFlight).toBeLessThanOrEqual(25);
    expect(reads.calls).toBe(1 + 60); // index + every row
  });

  it("stops reading once the limit is met", async () => {
    seedMany();
    const got = await listHomegrownOttoProposals({ status: "pending", limit: 2 });
    expect(got.map((p) => p.id)).toEqual(["id-00", "id-03"]);
    expect(reads.calls).toBe(1 + 25); // index + one batch
  });
});
