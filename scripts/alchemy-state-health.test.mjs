import { describe, expect, it } from "vitest";
import {
  SETTLED_STATUSES,
  checkStateSettled,
  findUnsettled,
  formatUnsettledFailure,
  readStateStoreCreds,
} from "./alchemy-state-health.mjs";

// The real open-seo/selfhost snapshot, 2026-09-17 after the repair: 17
// resources, 12 created + 5 updated. If the check fires on this it is useless.
const HEALTHY = [
  ["DB", "created"], ["GrokBotMcpServiceToken", "created"], ["KV", "created"],
  ["OAUTH_KV", "created"], ["open-seo", "updated"], ["R2", "created"],
  ["rank-check-workflow-selfhost", "created"],
  ["sam-loop-workflow-selfhost", "created"],
  ["SelfHostAccess", "updated"], ["SelfHostAllowUsers", "updated"],
  ["SelfHostInternalAccess", "created"], ["SelfHostInternalBypass", "created"],
  ["SelfHostMcpAccess", "updated"], ["SelfHostMcpDiscoveryAccess", "created"],
  ["SelfHostMcpDiscoveryBypass", "created"], ["SelfHostMcpServiceAuth", "updated"],
  ["site-audit-workflow-selfhost", "created"],
].map(([fqn, status]) => ({ fqn, status }));

// What NIC-775 actually looked like: one document frozen mid-update, holding an
// Access application id Cloudflare had already deleted.
const NIC_775 = HEALTHY.map((r) =>
  r.fqn === "SelfHostMcpAccess" ? { ...r, status: "updating" } : r,
);

describe("findUnsettled", () => {
  it("passes a healthy stage", () => {
    expect(findUnsettled(HEALTHY)).toEqual([]);
  });

  it("catches the NIC-775 state document", () => {
    const found = findUnsettled(NIC_775);
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({ fqn: "SelfHostMcpAccess", status: "updating" });
  });

  it.each(["creating", "updating", "deleting", "replacing"])(
    "catches an interrupted %s",
    (status) => {
      expect(findUnsettled([{ fqn: "X", status }])).toHaveLength(1);
    },
  );

  it("treats replaced as settled, so a healthy replace does not block a deploy", () => {
    expect(findUnsettled([{ fqn: "X", status: "replaced" }])).toEqual([]);
  });
});

describe("the check above is not vacuous", () => {
  it("the healthy fixture is the full 17-resource stage, not an empty list", () => {
    expect(HEALTHY).toHaveLength(17);
    expect(findUnsettled([])).toEqual([]);
  });

  it("the settled set excludes every in-flight status", () => {
    for (const status of ["creating", "updating", "deleting", "replacing"]) {
      expect(SETTLED_STATUSES).not.toContain(status);
    }
  });

  it("the NIC-775 fixture differs from the healthy one by exactly one row", () => {
    const changed = NIC_775.filter((r, i) => r.status !== HEALTHY[i].status);
    expect(changed).toHaveLength(1);
  });
});

describe("formatUnsettledFailure", () => {
  it("names the resource, its status, and where to look", () => {
    const msg = formatUnsettledFailure(findUnsettled(NIC_775), {
      stack: "open-seo",
      stage: "selfhost",
    });
    expect(msg).toContain("SelfHostMcpAccess");
    expect(msg).toContain("status=updating");
    expect(msg).toContain("application_already_exists");
    expect(msg).toContain("SELF_HOSTING_CLOUDFLARE_OPERATIONS.md");
  });
});

describe("checkStateSettled", () => {
  const deps = (resources) => ({
    homedir: "/home/test",
    readFileSync: () =>
      JSON.stringify({ url: "https://state.example/", authToken: "t" }),
    env: {},
    fetchImpl: async (url) => {
      const body = url.match(/resources\/(.+)$/)
        ? JSON.stringify(
            resources.find((r) => url.endsWith(`/${r.fqn}`)) ?? {},
          )
        : JSON.stringify(resources.map((r) => r.fqn));
      return { ok: true, status: 200, text: async () => body };
    },
  });

  it("reports ok on a healthy stage", async () => {
    const r = await checkStateSettled(
      { stack: "open-seo", stage: "selfhost" },
      deps(HEALTHY),
    );
    expect(r.outcome).toBe("ok");
    expect(r.checked).toBe(17);
  });

  it("reports unsettled on the NIC-775 stage", async () => {
    const r = await checkStateSettled(
      { stack: "open-seo", stage: "selfhost" },
      deps(NIC_775),
    );
    expect(r.outcome).toBe("unsettled");
    expect(r.message).toContain("SelfHostMcpAccess");
  });

  it("skips quietly when the state store is unreachable", async () => {
    const r = await checkStateSettled(
      { stack: "open-seo", stage: "selfhost" },
      {
        homedir: "/home/test",
        readFileSync: () => JSON.stringify({ url: "https://x/", authToken: "t" }),
        env: {},
        fetchImpl: async () => {
          throw new Error("network down");
        },
      },
    );
    expect(r.outcome).toBe("skipped");
  });

  it("skips quietly when there is no login to read", async () => {
    const r = await checkStateSettled(
      { stack: "open-seo", stage: "selfhost" },
      {
        homedir: "/home/test",
        readFileSync: () => {
          throw new Error("ENOENT");
        },
        env: {},
      },
    );
    expect(r.outcome).toBe("skipped");
  });
});

describe("readStateStoreCreds", () => {
  it("prefers explicit env over the profile file (CI reads a secret)", () => {
    const creds = readStateStoreCreds({
      homedir: "/home/test",
      readFileSync: () => {
        throw new Error("should not be read");
      },
      env: { ALCHEMY_STATE_URL: "https://ci/", ALCHEMY_STATE_TOKEN: "ci-token" },
    });
    expect(creds).toEqual({ url: "https://ci/", authToken: "ci-token" });
  });
});
