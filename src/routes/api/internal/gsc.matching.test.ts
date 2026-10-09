import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MockEnv } from "./internal-route-test-support";

const { mockEnv } = vi.hoisted(() => ({ mockEnv: {} as MockEnv }));

vi.mock("cloudflare:workers", () => ({
  env: mockEnv,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
}));

vi.mock("@/db", async () => {
  const { createActorDb } = await import("./internal-route-test-support");
  const { gscMocks } = await import("./gsc-route-test-support");
  return { db: createActorDb(gscMocks) };
});

vi.mock("@/server/features/projects/services/ProjectService", async () => {
  const { gscMocks } = await import("./gsc-route-test-support");
  return {
    ProjectService: {
      getProjectForOrganization: gscMocks.getProjectForOrganization,
    },
  };
});

vi.mock("@/server/features/gsc/services/GscService", async () => {
  const { gscMocks } = await import("./gsc-route-test-support");
  return {
    GscService: {
      getConnection: gscMocks.getConnection,
      listSitesForUserWithGrantStatus: gscMocks.listSitesForUserWithGrantStatus,
      setSite: gscMocks.setSite,
    },
  };
});

vi.mock("@/server/features/agency/AgencyScoreInputsService", async () => {
  const { gscMocks } = await import("./gsc-route-test-support");
  return { loadGscTotals: gscMocks.loadGscTotals };
});

import {
  CONNECTION,
  EARLY_GRANT,
  expectNoWrite,
  gscMocks,
  LATE_GRANT,
  listedAccounts,
  post,
  setGscDefaults,
  SITE_URL,
} from "./gsc-route-test-support";
import {
  auth,
  EARLY_MEMBER,
  LATE_MEMBER,
  ORG_ID,
  PROJECT,
  PROJECT_ID,
  TOKEN,
} from "./internal-route-test-support";
import { handlePost } from "./gsc";

const {
  listMembers,
  listGrants,
  getProjectForOrganization,
  listSitesForUserWithGrantStatus,
  setSite,
} = gscMocks;

beforeEach(() => {
  mockEnv.AGENCY_SCORE_EXPORT_TOKEN = TOKEN;
  delete mockEnv.AUTH_MODE;
  setGscDefaults();
});

describe("internal gsc handlePost site matching", () => {
  it("picks the earliest member even when that member has a blank email", async () => {
    listMembers.mockResolvedValue([
      { ...EARLY_MEMBER, userEmail: "" },
      LATE_MEMBER,
    ]);
    listGrants.mockResolvedValue([
      {
        userId: "user_late",
        accountId: "gsc_acct_late",
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
      },
      EARLY_GRANT,
    ]);

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(setSite).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_early",
        accountId: "gsc_acct_early",
      }),
    );
  });

  it("picks the earliest member who holds a grant, not the first row from the db", async () => {
    listGrants.mockResolvedValue([LATE_GRANT, EARLY_GRANT]);
    listSitesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "gsc_acct_early",
          sites: [{ siteUrl: SITE_URL, permissionLevel: "siteFullUser" }],
        },
      ]),
    );

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(setSite).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_early",
        accountId: "gsc_acct_early",
      }),
    );
    expect(listSitesForUserWithGrantStatus).toHaveBeenCalledWith("user_early");
  });

  it("falls through to the next grant holder when the earliest sees no matching property", async () => {
    listGrants.mockResolvedValue([EARLY_GRANT, LATE_GRANT]);
    listSitesForUserWithGrantStatus.mockImplementation(
      async (userId: string) => {
        if (userId === "user_early") {
          return listedAccounts([
            {
              accountId: "gsc_acct_early",
              sites: [
                {
                  siteUrl: "https://other.com/",
                  permissionLevel: "siteFullUser",
                },
              ],
            },
          ]);
        }
        return listedAccounts([
          {
            accountId: "gsc_acct_late",
            sites: [{ siteUrl: SITE_URL, permissionLevel: "siteFullUser" }],
          },
        ]);
      },
    );
    setSite.mockResolvedValue({
      ...CONNECTION,
      connectedByUserId: "user_late",
      gscAccountId: "gsc_acct_late",
    });

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(setSite).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      organizationId: ORG_ID,
      siteUrl: SITE_URL,
      accountId: "gsc_acct_late",
      userId: "user_late",
    });
  });

  it("returns the union of candidates across grant holders when none match", async () => {
    listGrants.mockResolvedValue([EARLY_GRANT, LATE_GRANT]);
    listSitesForUserWithGrantStatus.mockImplementation(
      async (userId: string) => {
        if (userId === "user_early") {
          return listedAccounts([
            {
              accountId: "gsc_acct_early",
              sites: [
                {
                  siteUrl: "https://example.com/path",
                  permissionLevel: "siteFullUser",
                },
                {
                  siteUrl: "https://other.com/",
                  permissionLevel: "siteFullUser",
                },
              ],
            },
          ]);
        }
        return listedAccounts([
          {
            accountId: "gsc_acct_late",
            sites: [
              {
                siteUrl: "https://www.example.com/blog",
                permissionLevel: "siteFullUser",
              },
              {
                siteUrl: "sc-domain:unrelated.net",
                permissionLevel: "siteFullUser",
              },
            ],
          },
        ]);
      },
    );

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "property_not_visible",
      reason: "no_match",
      candidates: ["https://example.com/path", "https://www.example.com/blog"],
    });
    expectNoWrite();
  });

  it("auto-picks sc-domain over URL-prefix properties and uses that accountId", async () => {
    listSitesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "gsc_acct_url",
          sites: [
            {
              siteUrl: "https://example.com/",
              permissionLevel: "siteFullUser",
            },
            {
              siteUrl: "http://www.example.com/",
              permissionLevel: "siteFullUser",
            },
          ],
        },
        {
          accountId: "gsc_acct_domain",
          sites: [{ siteUrl: SITE_URL, permissionLevel: "siteOwner" }],
        },
      ]),
    );
    setSite.mockResolvedValue({
      ...CONNECTION,
      gscAccountId: "gsc_acct_domain",
    });

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(setSite).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      organizationId: ORG_ID,
      siteUrl: SITE_URL,
      accountId: "gsc_acct_domain",
      userId: "user_early",
    });
  });

  it("auto-picks a URL-prefix property listed without a trailing slash", async () => {
    listSitesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "gsc_acct_early",
          sites: [
            { siteUrl: "https://example.com", permissionLevel: "siteFullUser" },
          ],
        },
      ]),
    );
    setSite.mockResolvedValue({
      ...CONNECTION,
      siteUrl: "https://example.com",
    });

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(setSite).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      organizationId: ORG_ID,
      siteUrl: "https://example.com",
      accountId: "gsc_acct_early",
      userId: "user_early",
    });
  });

  it("matches an explicit trailing-slash URL-prefix against a listed origin without a slash", async () => {
    listSitesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "gsc_acct_early",
          sites: [
            { siteUrl: "https://example.com", permissionLevel: "siteFullUser" },
          ],
        },
      ]),
    );
    setSite.mockResolvedValue({
      ...CONNECTION,
      siteUrl: "https://example.com",
    });

    const res = await handlePost(
      post({ projectId: PROJECT_ID, siteUrl: "https://example.com/" }, auth),
    );
    expect(res.status).toBe(200);
    expect(setSite).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      organizationId: ORG_ID,
      siteUrl: "https://example.com",
      accountId: "gsc_acct_early",
      userId: "user_early",
    });
  });

  it.each(["https://Example.com/path", "WWW.Example.com:443"])(
    "normalises project domain %s and auto-picks sc-domain:example.com",
    async (rawDomain) => {
      getProjectForOrganization.mockResolvedValueOnce({
        ...PROJECT,
        domain: rawDomain,
      });

      const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
      expect(res.status).toBe(200);
      expect(setSite).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        organizationId: ORG_ID,
        siteUrl: SITE_URL,
        accountId: "gsc_acct_early",
        userId: "user_early",
      });
    },
  );

  it("auto-picks http://www.<domain>/ when it is the only visible property", async () => {
    const httpWww = "http://www.example.com/";
    listSitesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "gsc_acct_early",
          sites: [{ siteUrl: httpWww, permissionLevel: "siteFullUser" }],
        },
      ]),
    );
    setSite.mockResolvedValue({ ...CONNECTION, siteUrl: httpWww });

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(setSite).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      organizationId: ORG_ID,
      siteUrl: httpWww,
      accountId: "gsc_acct_early",
      userId: "user_early",
    });
  });

  it("skips unverified properties when auto-picking", async () => {
    listSitesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "gsc_acct_early",
          sites: [
            { siteUrl: SITE_URL, permissionLevel: "siteUnverifiedUser" },
            {
              siteUrl: "https://example.com/",
              permissionLevel: "siteFullUser",
            },
          ],
        },
      ]),
    );
    setSite.mockResolvedValue({
      ...CONNECTION,
      siteUrl: "https://example.com/",
    });

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(setSite).toHaveBeenCalledWith(
      expect.objectContaining({ siteUrl: "https://example.com/" }),
    );
  });
});
