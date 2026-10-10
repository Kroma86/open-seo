import { describe, expect, it } from "vitest";
import {
  applyPlanToDoc,
  assertSafeToWrite,
  formatPlan,
  planRepair,
  summarizeDoc,
} from "./repair-alchemy-state.mjs";

// The NIC-775 document as it actually was, from the backup taken before the
// repair. Status frozen at "updating", both the current and the stashed `old`
// application id pointing at an app Cloudflare had already deleted, and
// `downstream` blanked while `old` still carried it.
const DEAD = "1d76ba41-ed8c-45bd-a943-a35b24873792";
const LIVE = "b490d2fe-08b6-4e43-89a5-d2946d2ad6b1";
const DEAD_AUD = "075998b9892dfeaaff15635e7f867a8a27a26cf6c9361b9591c3cf79e7f7b261";
const LIVE_AUD = "c01a5be02b2854c357aac6504d0d16047246520343aa4c9f43cfc8444759e560";

const nic775 = () => ({
  fqn: "SelfHostMcpAccess",
  resourceType: "Cloudflare.Access.Application",
  status: "updating",
  downstream: [],
  attr: { applicationId: DEAD, aud: DEAD_AUD, domain: "seo.niceseo.ai/mcp" },
  old: {
    status: "updated",
    downstream: ["open-seo"],
    attr: { applicationId: DEAD, aud: DEAD_AUD, domain: "seo.niceseo.ai/mcp" },
  },
});

const healthy = () => ({
  fqn: "SelfHostMcpAccess",
  resourceType: "Cloudflare.Access.Application",
  status: "updated",
  downstream: ["open-seo"],
  attr: { applicationId: LIVE, aud: LIVE_AUD, domain: "seo.niceseo.ai/mcp" },
});

describe("summarizeDoc", () => {
  it("reads the NIC-775 document", () => {
    expect(summarizeDoc(nic775())).toMatchObject({
      status: "updating",
      settled: false,
      applicationId: DEAD,
      downstream: [],
      oldDownstream: ["open-seo"],
      hasOld: true,
    });
  });
});

describe("planRepair without a target", () => {
  it("does nothing to a healthy document", () => {
    const plan = planRepair({ doc: healthy(), live: { applicationId: LIVE, aud: LIVE_AUD } });
    expect(plan.action).toBe("none");
    expect(plan.changes).toEqual([]);
  });

  it("settles a stuck document whose recorded app is still live", () => {
    const doc = { ...nic775(), attr: { ...nic775().attr, applicationId: LIVE, aud: LIVE_AUD } };
    const plan = planRepair({ doc, live: { applicationId: LIVE, aud: LIVE_AUD } });
    expect(plan.action).toBe("settle");
    expect(plan.changes).toContainEqual({ field: "status", from: "updating", to: "updated" });
  });

  it("refuses to guess when the recorded app is gone, and names the live one", () => {
    const plan = planRepair({ doc: nic775(), live: { applicationId: LIVE, aud: LIVE_AUD } });
    expect(plan.action).toBe("none");
    expect(plan.refusals.join(" ")).toContain(LIVE);
    expect(plan.refusals.join(" ")).toContain("--repoint");
  });
});

describe("planRepair with --repoint", () => {
  it("repoints id, aud, status, old and downstream in one plan", () => {
    const plan = planRepair({
      doc: nic775(),
      live: { applicationId: LIVE, aud: LIVE_AUD },
      targetAppId: LIVE,
    });
    expect(plan.action).toBe("repoint");
    expect(plan.changes).toContainEqual({ field: "attr.applicationId", from: DEAD, to: LIVE });
    expect(plan.changes).toContainEqual({ field: "attr.aud", from: DEAD_AUD, to: LIVE_AUD });
    expect(plan.changes).toContainEqual({ field: "status", from: "updating", to: "updated" });
    expect(plan.changes).toContainEqual({ field: "old", from: "present", to: "dropped" });
    expect(plan.changes).toContainEqual({
      field: "downstream",
      from: "[]",
      to: '["open-seo"]',
    });
  });

  it("refuses when Cloudflare could not be observed at all", () => {
    const plan = planRepair({ doc: nic775(), live: undefined, targetAppId: LIVE });
    expect(plan.action).toBe("none");
    expect(plan.refusals.join(" ")).toContain("not observed live");
  });

  it("refuses when the requested id is not the one live on that domain", () => {
    const plan = planRepair({
      doc: nic775(),
      live: { applicationId: LIVE, aud: LIVE_AUD },
      targetAppId: "deadbeef-0000-0000-0000-000000000000",
    });
    expect(plan.action).toBe("none");
    expect(plan.refusals.join(" ")).toContain(LIVE);
  });
});

describe("applyPlanToDoc", () => {
  it("produces the document the repair intended", () => {
    const doc = nic775();
    const plan = planRepair({
      doc,
      live: { applicationId: LIVE, aud: LIVE_AUD },
      targetAppId: LIVE,
    });
    const out = applyPlanToDoc(doc, plan);
    expect(out.attr.applicationId).toBe(LIVE);
    expect(out.attr.aud).toBe(LIVE_AUD);
    expect(out.status).toBe("updated");
    expect(out.old).toBeUndefined();
    expect(out.downstream).toEqual(["open-seo"]);
  });

  it("does not mutate the input document", () => {
    const doc = nic775();
    const plan = planRepair({
      doc,
      live: { applicationId: LIVE, aud: LIVE_AUD },
      targetAppId: LIVE,
    });
    applyPlanToDoc(doc, plan);
    expect(doc.attr.applicationId).toBe(DEAD);
    expect(doc.status).toBe("updating");
    expect(doc.old).toBeDefined();
  });

  it("returns the document untouched when the plan refused", () => {
    const doc = nic775();
    const plan = planRepair({ doc, live: undefined, targetAppId: LIVE });
    expect(applyPlanToDoc(doc, plan)).toBe(doc);
  });
});

describe("assertSafeToWrite", () => {
  it("passes a correct repair", () => {
    const doc = nic775();
    const plan = planRepair({
      doc,
      live: { applicationId: LIVE, aud: LIVE_AUD },
      targetAppId: LIVE,
    });
    expect(assertSafeToWrite(doc, applyPlanToDoc(doc, plan))).toEqual([]);
  });

  // This is the mistake the tool exists to prevent. `downstream` is how the
  // Worker reaches the Access aud; a repair that drops it looks fine and
  // silently breaks the gate.
  it("refuses a repair that would drop a non-empty downstream", () => {
    const before = nic775();
    const after = { ...healthy(), downstream: [] };
    const problems = assertSafeToWrite(before, after);
    expect(problems.join(" ")).toContain("downstream");
  });

  it("refuses a document left unsettled", () => {
    const problems = assertSafeToWrite(nic775(), { ...healthy(), status: "updating" });
    expect(problems.join(" ")).toContain("status would still be updating");
  });

  it("refuses a document with no application id", () => {
    const problems = assertSafeToWrite(nic775(), { ...healthy(), attr: {} });
    expect(problems.join(" ")).toContain("no attr.applicationId");
  });
});

describe("the checks above are not vacuous", () => {
  it("the fixture really is drifted — its two ids differ and one is stale", () => {
    expect(nic775().attr.applicationId).toBe(DEAD);
    expect(DEAD).not.toBe(LIVE);
    expect(summarizeDoc(nic775()).settled).toBe(false);
  });

  it("a refusal is distinguishable from a no-op", () => {
    const refused = planRepair({ doc: nic775(), live: undefined, targetAppId: LIVE });
    const noop = planRepair({ doc: healthy(), live: { applicationId: LIVE, aud: LIVE_AUD } });
    expect(refused.refusals.length).toBeGreaterThan(0);
    expect(noop.refusals).toEqual([]);
    expect(formatPlan(refused, { fqn: "X" })).toContain("REFUSED");
    expect(formatPlan(noop, { fqn: "X" })).toContain("nothing to do");
  });

  it("assertSafeToWrite would catch a hand-written repair that forgot downstream", () => {
    // Exactly what a careless curl PUT produces: right ids, lost downstream.
    const handWritten = {
      ...nic775(),
      status: "updated",
      attr: { applicationId: LIVE, aud: LIVE_AUD, domain: "seo.niceseo.ai/mcp" },
      downstream: [],
      old: undefined,
    };
    expect(assertSafeToWrite(nic775(), handWritten).length).toBeGreaterThan(0);
  });
});
