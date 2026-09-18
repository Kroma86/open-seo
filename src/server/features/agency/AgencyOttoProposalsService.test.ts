import { beforeEach, describe, expect, it, vi } from "vitest";

// The KV rows these tests feed are real shapes taken from production on
// 2026-09-18, not invented ones. See the `organizationId` case below.
const store = new Map<string, string>();

vi.mock("cloudflare:workers", () => ({
  env: {
    KV: {
      get: async (key: string) => store.get(key) ?? null,
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
