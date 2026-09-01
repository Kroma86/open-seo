import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";

const {
  mockEnv,
  listMembers,
  listGrants,
  getProjectForOrganization,
  getConnection,
  listSitesForUserWithGrantStatus,
  setSite,
  loadGscTotals,
} = vi.hoisted(() => {
  const listMembers = vi.fn();
  const listGrants = vi.fn();
  return {
    mockEnv: {} as { AGENCY_SCORE_EXPORT_TOKEN?: string; AUTH_MODE?: string },
    listMembers,
    listGrants,
    getProjectForOrganization: vi.fn(),
    getConnection: vi.fn(),
    listSitesForUserWithGrantStatus: vi.fn(),
    setSite: vi.fn(),
    loadGscTotals: vi.fn(),
  };
});

vi.mock("cloudflare:workers", () => ({
  env: mockEnv,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
}));

vi.mock("@/db", () => {
  const chain: {
    from: () => unknown;
    innerJoin: () => unknown;
    where: () => unknown;
    orderBy: () => unknown;
    limit: () => unknown;
    then: (
      onFulfilled: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise<unknown>;
    _kind: "members" | "grants";
  } = {
    _kind: "grants",
    from: () => {
      chain._kind = "grants";
      return chain;
    },
    innerJoin: () => {
      chain._kind = "members";
      return chain;
    },
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (
      onFulfilled: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) =>
      Promise.resolve(chain._kind === "members" ? listMembers() : listGrants()).then(
        onFulfilled,
        onRejected,
      ),
  };
  return { db: { select: () => chain } };
});

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: (...args: unknown[]) =>
      getProjectForOrganization(...args),
  },
}));

vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: {
    getConnection: (...args: unknown[]) => getConnection(...args),
    listSitesForUserWithGrantStatus: (...args: unknown[]) =>
      listSitesForUserWithGrantStatus(...args),
    setSite: (...args: unknown[]) => setSite(...args),
  },
}));

vi.mock("@/server/features/agency/AgencyScoreInputsService", () => ({
  loadGscTotals: (...args: unknown[]) => loadGscTotals(...args),
}));

import { handleGet, handlePost } from "./gsc";

const TOKEN = "test-export-token";
const BASE = "http://localhost/api/internal/gsc";
const ORG_ID = "shared-workspace";
const PROJECT_ID = "project_1";
const SITE_URL = "sc-domain:example.com";

const PROJECT = {
  id: PROJECT_ID,
  name: "Acme",
  domain: "example.com",
  locationCode: 2840,
  languageCode: "en",
  createdAt: "2026-01-01 00:00:00",
};

const EARLY_MEMBER = {
  userId: "user_early",
  userEmail: "early@example.com",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const LATE_MEMBER = {
  userId: "user_late",
  userEmail: "late@example.com",
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
};

const EARLY_GRANT = {
  userId: "user_early",
  accountId: "gsc_acct_early",
  createdAt: new Date("2026-01-02T00:00:00.000Z"),
};

const LATE_GRANT = {
  userId: "user_late",
  accountId: "gsc_acct_late",
  createdAt: new Date("2026-01-03T00:00:00.000Z"),
};

const CONNECTION = {
  id: "gsc_conn_1",
  projectId: PROJECT_ID,
  organizationId: ORG_ID,
  siteUrl: SITE_URL,
  connectedByUserId: "user_early",
  gscAccountId: "gsc_acct_early",
  connectedAccountEmail: "early@example.com",
  createdAt: "2026-08-01 00:00:00",
  updatedAt: "2026-08-01 00:00:00",
};

const SNAPSHOT = {
  clicks: 10,
  impressions: 100,
  ctr: 0.1,
  position: 5.2,
  capturedAt: "2026-08-01",
  source: "google_search_console" as const,
};

function listedAccounts(
  accounts: Array<{
    accountId: string;
    requiresReconnect?: boolean;
    sites: Array<{ siteUrl: string; permissionLevel: string }>;
  }>,
) {
  return {
    accounts: accounts.map((account) => ({
      accountId: account.accountId,
      email: "early@example.com",
      requiresReconnect: account.requiresReconnect ?? false,
      sites: account.sites,
    })),
  };
}

function get(path = "", headers?: HeadersInit): Request {
  return new Request(`${BASE}${path}`, { headers });
}

function post(
  body?: unknown,
  headers?: HeadersInit,
  rawBody?: string,
): Request {
  return new Request(BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
    body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
}

const auth = { authorization: `Bearer ${TOKEN}` };

function expectNoWrite() {
  expect(setSite).not.toHaveBeenCalled();
}

beforeEach(() => {
  mockEnv.AGENCY_SCORE_EXPORT_TOKEN = TOKEN;
  delete mockEnv.AUTH_MODE;
  getProjectForOrganization.mockImplementation(
    async (_organizationId: string, projectId: string) => {
      if (projectId === PROJECT_ID) return PROJECT;
      throw new AppError("NOT_FOUND");
    },
  );
  listMembers.mockResolvedValue([LATE_MEMBER, EARLY_MEMBER]);
  listGrants.mockResolvedValue([EARLY_GRANT]);
  getConnection.mockResolvedValue(null);
  listSitesForUserWithGrantStatus.mockResolvedValue(
    listedAccounts([
      {
        accountId: "gsc_acct_early",
        sites: [{ siteUrl: SITE_URL, permissionLevel: "siteFullUser" }],
      },
    ]),
  );
  setSite.mockResolvedValue(CONNECTION);
  loadGscTotals.mockResolvedValue(SNAPSHOT);
});

describe("internal gsc auth", () => {
  it("returns 503 agency_score_export_disabled when token unset", async () => {
    delete mockEnv.AGENCY_SCORE_EXPORT_TOKEN;
    const res = await handleGet(get(`?projectId=${PROJECT_ID}`, auth));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "agency_score_export_disabled" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(getProjectForOrganization).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("returns 401 when bearer is missing", async () => {
    const res = await handleGet(get(`?projectId=${PROJECT_ID}`));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(getProjectForOrganization).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("returns 401 when bearer is wrong", async () => {
    const res = await handlePost(
      post({ projectId: PROJECT_ID }, { authorization: "Bearer wrong-token" }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expectNoWrite();
  });

  it("refuses both verbs with 403 under AUTH_MODE=hosted", async () => {
    mockEnv.AUTH_MODE = "hosted";

    const listed = await handleGet(get(`?projectId=${PROJECT_ID}`, auth));
    expect(listed.status).toBe(403);
    expect(await listed.json()).toEqual({ error: "unsupported_auth_mode" });

    const attached = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(attached.status).toBe(403);
    expect(await attached.json()).toEqual({ error: "unsupported_auth_mode" });
    expect(getProjectForOrganization).not.toHaveBeenCalled();
    expectNoWrite();
  });

  it("scopes ownership and setSite to delegated-local-admin under AUTH_MODE=local_noauth", async () => {
    mockEnv.AUTH_MODE = "local_noauth";

    const listed = await handleGet(get(`?projectId=${PROJECT_ID}`, auth));
    expect(listed.status).toBe(200);
    expect(getProjectForOrganization).toHaveBeenCalledWith(
      "delegated-local-admin",
      PROJECT_ID,
    );

    const attached = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(attached.status).toBe(200);
    expect(setSite).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      organizationId: "delegated-local-admin",
      siteUrl: SITE_URL,
      accountId: "gsc_acct_early",
      userId: "user_early",
    });
  });
});

describe("internal gsc ownership", () => {
  it("returns 404 when projectId is not in the resolved org", async () => {
    const listed = await handleGet(get("?projectId=other_project", auth));
    expect(listed.status).toBe(404);
    expect(await listed.json()).toEqual({ error: "project_not_found" });

    const attached = await handlePost(
      post({ projectId: "other_project" }, auth),
    );
    expect(attached.status).toBe(404);
    expect(await attached.json()).toEqual({ error: "project_not_found" });
    expectNoWrite();
    expect(listMembers).not.toHaveBeenCalled();
  });
});

describe("internal gsc handleGet", () => {
  it("returns 400 invalid_query when projectId is missing", async () => {
    const res = await handleGet(get("", auth));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_query" });
    expect(getProjectForOrganization).not.toHaveBeenCalled();
  });

  it("returns connected false and a null snapshot when unmapped", async () => {
    const res = await handleGet(get(`?projectId=${PROJECT_ID}`, auth));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      projectId: PROJECT_ID,
      connected: false,
      siteUrl: null,
      connectedAt: null,
      snapshot: null,
    });
    expect(loadGscTotals).not.toHaveBeenCalled();
    expect(getProjectForOrganization).toHaveBeenCalledWith(ORG_ID, PROJECT_ID);
  });

  it("returns the mapping and snapshot when connected", async () => {
    getConnection.mockResolvedValue(CONNECTION);

    const res = await handleGet(get(`?projectId=${PROJECT_ID}`, auth));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      projectId: PROJECT_ID,
      connected: true,
      siteUrl: SITE_URL,
      connectedAt: CONNECTION.createdAt,
      snapshot: SNAPSHOT,
    });
    expect(loadGscTotals).toHaveBeenCalledWith(PROJECT_ID, true);
  });
});

describe("internal gsc handlePost", () => {
  it("returns 400 invalid_json on malformed JSON", async () => {
    const res = await handlePost(post(undefined, auth, "{not-json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
    expectNoWrite();
  });

  it("returns 400 invalid_body for an empty projectId", async () => {
    const res = await handlePost(post({ projectId: "" }, auth));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
    expectNoWrite();
  });

  it("returns 400 project_has_no_domain when the project domain is null", async () => {
    getProjectForOrganization.mockResolvedValueOnce({
      ...PROJECT,
      domain: null,
    });

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "project_has_no_domain" });
    expectNoWrite();
  });

  it("returns 200 idempotent for the same mapping and does not write", async () => {
    getConnection.mockResolvedValue(CONNECTION);

    const res = await handlePost(
      post({ projectId: PROJECT_ID, siteUrl: SITE_URL }, auth),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      projectId: PROJECT_ID,
      siteUrl: SITE_URL,
      connectedAt: CONNECTION.createdAt,
      snapshot: SNAPSHOT,
    });
    expectNoWrite();
    expect(listSitesForUserWithGrantStatus).not.toHaveBeenCalled();
  });

  it("returns 200 idempotent when siteUrl is omitted and already connected", async () => {
    getConnection.mockResolvedValue(CONNECTION);

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ siteUrl: SITE_URL });
    expectNoWrite();
  });

  it("returns 409 already_connected for a different mapping and does not write", async () => {
    getConnection.mockResolvedValue(CONNECTION);

    const res = await handlePost(
      post({ projectId: PROJECT_ID, siteUrl: "https://example.com/" }, auth),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "already_connected",
      siteUrl: SITE_URL,
    });
    expectNoWrite();
  });

  it("returns 404 no_grant when no member holds a google-search-console grant", async () => {
    listGrants.mockResolvedValueOnce([]);

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "property_not_visible",
      reason: "no_grant",
      candidates: [],
    });
    expect(listSitesForUserWithGrantStatus).not.toHaveBeenCalled();
    expectNoWrite();
  });

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
    listGrants.mockResolvedValue([
      LATE_GRANT,
      EARLY_GRANT,
    ]);
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
    listSitesForUserWithGrantStatus.mockImplementation(async (userId: string) => {
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
    });
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
    listSitesForUserWithGrantStatus.mockImplementation(async (userId: string) => {
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
    });

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
            { siteUrl: "https://example.com/", permissionLevel: "siteFullUser" },
            { siteUrl: "http://www.example.com/", permissionLevel: "siteFullUser" },
          ],
        },
        {
          accountId: "gsc_acct_domain",
          sites: [{ siteUrl: SITE_URL, permissionLevel: "siteOwner" }],
        },
      ]),
    );
    setSite.mockResolvedValue({ ...CONNECTION, gscAccountId: "gsc_acct_domain" });

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

  it("skips accounts that require reconnect", async () => {
    listSitesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "gsc_acct_stale",
          requiresReconnect: true,
          sites: [{ siteUrl: SITE_URL, permissionLevel: "siteFullUser" }],
        },
        {
          accountId: "gsc_acct_early",
          sites: [
            {
              siteUrl: "https://www.example.com/",
              permissionLevel: "siteFullUser",
            },
          ],
        },
      ]),
    );
    setSite.mockResolvedValue({
      ...CONNECTION,
      siteUrl: "https://www.example.com/",
      gscAccountId: "gsc_acct_early",
    });

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(setSite).toHaveBeenCalledWith(
      expect.objectContaining({
        siteUrl: "https://www.example.com/",
        accountId: "gsc_acct_early",
      }),
    );
  });

  it("auto-picks the earliest holder account when the same siteUrl is visible twice", async () => {
    listGrants.mockResolvedValue([
      {
        userId: "user_early",
        accountId: "acc-new",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
      {
        userId: "user_early",
        accountId: "acc-old",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    ]);
    listSitesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "acc-new",
          sites: [{ siteUrl: SITE_URL, permissionLevel: "siteFullUser" }],
        },
        {
          accountId: "acc-old",
          sites: [{ siteUrl: SITE_URL, permissionLevel: "siteFullUser" }],
        },
      ]),
    );

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(setSite).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      organizationId: ORG_ID,
      siteUrl: SITE_URL,
      accountId: "acc-old",
      userId: "user_early",
    });
  });

  it("lists host-equal candidates and ignores substring lookalikes", async () => {
    getProjectForOrganization.mockResolvedValueOnce({
      ...PROJECT,
      domain: "app.com",
    });
    listSitesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "gsc_acct_early",
          sites: [
            { siteUrl: "sc-domain:myapp.com", permissionLevel: "siteFullUser" },
            {
              siteUrl: "https://app.competitor.net/",
              permissionLevel: "siteFullUser",
            },
            { siteUrl: "sc-domain:app.com", permissionLevel: "siteFullUser" },
            {
              siteUrl: "https://www.app.com/",
              permissionLevel: "siteFullUser",
            },
          ],
        },
      ]),
    );

    const res = await handlePost(
      post({ projectId: PROJECT_ID, siteUrl: "https://missing.com/" }, auth),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "property_not_visible",
      reason: "not_visible",
      candidates: ["sc-domain:app.com", "https://www.app.com/"],
    });
    expectNoWrite();
  });

  it("returns 409 site_url_mismatch for an explicit siteUrl on another host", async () => {
    listSitesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "gsc_acct_early",
          sites: [
            { siteUrl: SITE_URL, permissionLevel: "siteFullUser" },
            {
              siteUrl: "https://other.com/",
              permissionLevel: "siteFullUser",
            },
          ],
        },
      ]),
    );

    const res = await handlePost(
      post({ projectId: PROJECT_ID, siteUrl: "https://other.com/" }, auth),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "site_url_mismatch",
      siteUrl: "https://other.com/",
      domain: "example.com",
    });
    expectNoWrite();
  });

  it("attaches an explicit https://www.<domain>/ siteUrl", async () => {
    const wwwUrl = "https://www.example.com/";
    listSitesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "gsc_acct_early",
          sites: [{ siteUrl: wwwUrl, permissionLevel: "siteFullUser" }],
        },
      ]),
    );
    setSite.mockResolvedValue({ ...CONNECTION, siteUrl: wwwUrl });

    const res = await handlePost(
      post({ projectId: PROJECT_ID, siteUrl: wwwUrl }, auth),
    );
    expect(res.status).toBe(200);
    expect(setSite).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      organizationId: ORG_ID,
      siteUrl: wwwUrl,
      accountId: "gsc_acct_early",
      userId: "user_early",
    });
  });

  it("returns 404 no_match when visible sites are only unrelated hosts", async () => {
    listSitesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "gsc_acct_early",
          sites: [
            {
              siteUrl: "https://other.com/",
              permissionLevel: "siteFullUser",
            },
            {
              siteUrl: "sc-domain:unrelated.net",
              permissionLevel: "siteFullUser",
            },
          ],
        },
      ]),
    );

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "property_not_visible",
      reason: "no_match",
      candidates: [],
    });
    expectNoWrite();
  });

  it("returns 404 not_visible for an explicit siteUrl outside the visible set", async () => {
    listSitesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "gsc_acct_early",
          sites: [
            { siteUrl: SITE_URL, permissionLevel: "siteFullUser" },
            {
              siteUrl: "https://other.com/",
              permissionLevel: "siteFullUser",
            },
          ],
        },
      ]),
    );

    const res = await handlePost(
      post({ projectId: PROJECT_ID, siteUrl: "https://missing.com/" }, auth),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "property_not_visible",
      reason: "not_visible",
      candidates: [SITE_URL],
    });
    expectNoWrite();
  });

  it("attaches successfully with snapshot and the listing accountId", async () => {
    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      projectId: PROJECT_ID,
      siteUrl: SITE_URL,
      connectedAt: CONNECTION.createdAt,
      snapshot: SNAPSHOT,
    });
    expect(setSite).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      organizationId: ORG_ID,
      siteUrl: SITE_URL,
      accountId: "gsc_acct_early",
      userId: "user_early",
    });
    expect(loadGscTotals).toHaveBeenCalledWith(PROJECT_ID, true);
  });

  it("returns snapshot null when the snapshot computation throws", async () => {
    loadGscTotals.mockRejectedValueOnce(new Error("gsc down"));

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      projectId: PROJECT_ID,
      siteUrl: SITE_URL,
      connectedAt: CONNECTION.createdAt,
      snapshot: null,
    });
    expect(setSite).toHaveBeenCalled();
  });

  it("maps setSite FORBIDDEN to 403 property_unverified", async () => {
    setSite.mockRejectedValueOnce(new AppError("FORBIDDEN", "unverified"));

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "property_unverified" });
  });

  it("maps setSite NOT_FOUND to 404 property_not_visible service_rejected", async () => {
    setSite.mockRejectedValueOnce(new AppError("NOT_FOUND", "missing"));

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "property_not_visible",
      reason: "service_rejected",
      candidates: [SITE_URL],
    });
  });

  it("maps a generic setSite error to 500 attach_failed", async () => {
    setSite.mockRejectedValueOnce(new Error("gsc down"));

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "attach_failed" });
  });
});
