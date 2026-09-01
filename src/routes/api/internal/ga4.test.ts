import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";

const {
  mockEnv,
  listMembers,
  listGrants,
  getProjectForOrganization,
  getConnection,
  listPropertiesForUserWithGrantStatus,
  setProperty,
} = vi.hoisted(() => {
  const listMembers = vi.fn();
  const listGrants = vi.fn();
  return {
    mockEnv: {} as { AGENCY_SCORE_EXPORT_TOKEN?: string; AUTH_MODE?: string },
    listMembers,
    listGrants,
    getProjectForOrganization: vi.fn(),
    getConnection: vi.fn(),
    listPropertiesForUserWithGrantStatus: vi.fn(),
    setProperty: vi.fn(),
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

vi.mock("@/server/features/ga4/services/Ga4Service", () => ({
  Ga4Service: {
    getConnection: (...args: unknown[]) => getConnection(...args),
    listPropertiesForUserWithGrantStatus: (...args: unknown[]) =>
      listPropertiesForUserWithGrantStatus(...args),
    setProperty: (...args: unknown[]) => setProperty(...args),
  },
}));

import { handleGet, handlePost } from "./ga4";

const TOKEN = "test-export-token";
const BASE = "http://localhost/api/internal/ga4";
const ORG_ID = "shared-workspace";
const PROJECT_ID = "project_1";
const PROPERTY_ID = "properties/123456";

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
  accountId: "ga4_acct_early",
  createdAt: new Date("2026-01-02T00:00:00.000Z"),
};

const LATE_GRANT = {
  userId: "user_late",
  accountId: "ga4_acct_late",
  createdAt: new Date("2026-01-03T00:00:00.000Z"),
};

const CONNECTION = {
  id: "ga4_conn_1",
  projectId: PROJECT_ID,
  organizationId: ORG_ID,
  propertyId: PROPERTY_ID,
  propertyDisplayName: "example.com",
  propertyTimeZone: "America/New_York",
  propertyCurrencyCode: "USD",
  connectedByUserId: "user_early",
  ga4AccountId: "ga4_acct_early",
  connectedAccountEmail: "early@example.com",
  createdAt: "2026-08-01 00:00:00",
  updatedAt: "2026-08-01 00:00:00",
};

function listedAccounts(
  accounts: Array<{
    accountId: string;
    requiresReconnect?: boolean;
    propertiesUnavailable?: boolean;
    properties: Array<{ propertyId: string; displayName: string }>;
  }>,
) {
  return {
    accounts: accounts.map((account) => ({
      accountId: account.accountId,
      email: "early@example.com",
      requiresReconnect: account.requiresReconnect ?? false,
      propertiesUnavailable: account.propertiesUnavailable ?? false,
      properties: account.properties.map((property) => ({
        propertyId: property.propertyId,
        displayName: property.displayName,
        accountDisplayName: "Acme",
      })),
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
  expect(setProperty).not.toHaveBeenCalled();
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
  listPropertiesForUserWithGrantStatus.mockResolvedValue(
    listedAccounts([
      {
        accountId: "ga4_acct_early",
        properties: [{ propertyId: PROPERTY_ID, displayName: "example.com" }],
      },
    ]),
  );
  setProperty.mockResolvedValue(CONNECTION);
});

describe("internal ga4 auth", () => {
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

  it("scopes ownership and setProperty to delegated-local-admin under AUTH_MODE=local_noauth", async () => {
    mockEnv.AUTH_MODE = "local_noauth";

    const listed = await handleGet(get(`?projectId=${PROJECT_ID}`, auth));
    expect(listed.status).toBe(200);
    expect(getProjectForOrganization).toHaveBeenCalledWith(
      "delegated-local-admin",
      PROJECT_ID,
    );

    const attached = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(attached.status).toBe(200);
    expect(setProperty).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      organizationId: "delegated-local-admin",
      propertyId: PROPERTY_ID,
      accountId: "ga4_acct_early",
      userId: "user_early",
    });
  });
});

describe("internal ga4 ownership", () => {
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

describe("internal ga4 handleGet", () => {
  it("returns 400 invalid_query when projectId is missing", async () => {
    const res = await handleGet(get("", auth));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_query" });
    expect(getProjectForOrganization).not.toHaveBeenCalled();
  });

  it("returns connected false when unmapped", async () => {
    const res = await handleGet(get(`?projectId=${PROJECT_ID}`, auth));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      projectId: PROJECT_ID,
      connected: false,
      propertyId: null,
      displayName: null,
      connectedAt: null,
    });
    expect(getProjectForOrganization).toHaveBeenCalledWith(ORG_ID, PROJECT_ID);
  });

  it("returns the mapping when connected", async () => {
    getConnection.mockResolvedValue(CONNECTION);

    const res = await handleGet(get(`?projectId=${PROJECT_ID}`, auth));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      projectId: PROJECT_ID,
      connected: true,
      propertyId: PROPERTY_ID,
      displayName: "example.com",
      connectedAt: CONNECTION.createdAt,
    });
  });
});

describe("internal ga4 handlePost", () => {
  it("returns 400 invalid_json on malformed JSON", async () => {
    const res = await handlePost(post(undefined, auth, "{not-json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
    expectNoWrite();
  });

  it("returns 400 invalid_body for a malformed propertyId", async () => {
    const res = await handlePost(
      post({ projectId: PROJECT_ID, propertyId: "123456" }, auth),
    );
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
      post({ projectId: PROJECT_ID, propertyId: PROPERTY_ID }, auth),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      projectId: PROJECT_ID,
      propertyId: PROPERTY_ID,
      displayName: "example.com",
      connectedAt: CONNECTION.createdAt,
    });
    expectNoWrite();
    expect(listPropertiesForUserWithGrantStatus).not.toHaveBeenCalled();
  });

  it("returns 200 idempotent when propertyId is omitted and already connected", async () => {
    getConnection.mockResolvedValue(CONNECTION);

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ propertyId: PROPERTY_ID });
    expectNoWrite();
  });

  it("returns 409 already_connected for a different mapping and does not write", async () => {
    getConnection.mockResolvedValue(CONNECTION);

    const res = await handlePost(
      post({ projectId: PROJECT_ID, propertyId: "properties/999" }, auth),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "already_connected",
      propertyId: PROPERTY_ID,
      displayName: "example.com",
    });
    expectNoWrite();
  });

  it("returns 404 no_grant when no member holds a google-analytics grant", async () => {
    listGrants.mockResolvedValueOnce([]);

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "property_not_visible",
      reason: "no_grant",
      candidates: [],
    });
    expect(listPropertiesForUserWithGrantStatus).not.toHaveBeenCalled();
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
        accountId: "ga4_acct_late",
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
      },
      EARLY_GRANT,
    ]);

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(setProperty).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_early",
        accountId: "ga4_acct_early",
      }),
    );
  });

  it("picks the earliest member who holds a grant, not the first row from the db", async () => {
    listGrants.mockResolvedValue([LATE_GRANT, EARLY_GRANT]);

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(setProperty).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_early",
        accountId: "ga4_acct_early",
      }),
    );
    expect(listPropertiesForUserWithGrantStatus).toHaveBeenCalledWith(
      "user_early",
    );
  });

  it("falls through to the next grant holder when the earliest sees no matching property", async () => {
    listGrants.mockResolvedValue([EARLY_GRANT, LATE_GRANT]);
    listPropertiesForUserWithGrantStatus.mockImplementation(
      async (userId: string) => {
        if (userId === "user_early") {
          return listedAccounts([
            {
              accountId: "ga4_acct_early",
              properties: [
                { propertyId: "properties/1", displayName: "unrelated.com" },
              ],
            },
          ]);
        }
        return listedAccounts([
          {
            accountId: "ga4_acct_late",
            properties: [{ propertyId: PROPERTY_ID, displayName: "example.com" }],
          },
        ]);
      },
    );
    setProperty.mockResolvedValue({
      ...CONNECTION,
      connectedByUserId: "user_late",
      ga4AccountId: "ga4_acct_late",
    });

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(setProperty).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      organizationId: ORG_ID,
      propertyId: PROPERTY_ID,
      accountId: "ga4_acct_late",
      userId: "user_late",
    });
  });

  it("returns the union of candidates across grant holders when none match", async () => {
    listGrants.mockResolvedValue([EARLY_GRANT, LATE_GRANT]);
    listPropertiesForUserWithGrantStatus.mockImplementation(
      async (userId: string) => {
        if (userId === "user_early") {
          return listedAccounts([
            {
              accountId: "ga4_acct_early",
              properties: [
                { propertyId: "properties/1", displayName: "other.com" },
              ],
            },
          ]);
        }
        return listedAccounts([
          {
            accountId: "ga4_acct_late",
            properties: [
              { propertyId: "properties/2", displayName: "elsewhere.com" },
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
      candidates: [
        { propertyId: "properties/1", displayName: "other.com" },
        { propertyId: "properties/2", displayName: "elsewhere.com" },
      ],
    });
    expectNoWrite();
  });

  it.each([
    ["exact", "example.com"],
    ["www-strip", "www.example.com"],
    [" - ga4 suffix", "example.com - ga4"],
    [" (ga4) suffix", "example.com (ga4)"],
    ["https exact", "https://example.com"],
    ["https prefix with slash", "https://example.com/stats"],
    ["http prefix", "http://example.com"],
    ["https with query", "https://example.com?utm=1"],
    ["https with hash", "https://example.com#main"],
    ["https with space", "https://example.com extra"],
  ])("auto-picks a display name that matches (%s)", async (_label, displayName) => {
    listPropertiesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "ga4_acct_early",
          properties: [
            { propertyId: "properties/1", displayName: "unrelated" },
            { propertyId: PROPERTY_ID, displayName },
          ],
        },
      ]),
    );
    setProperty.mockResolvedValue({
      ...CONNECTION,
      propertyDisplayName: displayName,
    });

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(setProperty).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      organizationId: ORG_ID,
      propertyId: PROPERTY_ID,
      accountId: "ga4_acct_early",
      userId: "user_early",
    });
  });

  it.each(["https://Example.com/path", "WWW.Example.com:443"])(
    "normalises project domain %s and auto-picks the property named example.com",
    async (rawDomain) => {
      getProjectForOrganization.mockResolvedValueOnce({
        ...PROJECT,
        domain: rawDomain,
      });

      const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
      expect(res.status).toBe(200);
      expect(setProperty).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        organizationId: ORG_ID,
        propertyId: PROPERTY_ID,
        accountId: "ga4_acct_early",
        userId: "user_early",
      });
    },
  );

  it.each([
    ["suffix shop", "example.comshop"],
    ["subdomain", "sub.example.com"],
    ["https other host", "https://example.com.evil.com"],
  ])("does not match a near-miss display name (%s)", async (_label, displayName) => {
    listPropertiesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "ga4_acct_early",
          properties: [{ propertyId: PROPERTY_ID, displayName }],
        },
      ]),
    );

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "property_not_visible",
      reason: "no_match",
      candidates: [{ propertyId: PROPERTY_ID, displayName }],
    });
    expectNoWrite();
  });

  it("returns 409 ambiguous when more than one display name matches", async () => {
    listPropertiesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "ga4_acct_early",
          properties: [
            { propertyId: "properties/1", displayName: "example.com" },
            { propertyId: "properties/2", displayName: "www.example.com" },
          ],
        },
      ]),
    );

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "ambiguous",
      candidates: [
        { propertyId: "properties/1", displayName: "example.com" },
        { propertyId: "properties/2", displayName: "www.example.com" },
      ],
    });
    expectNoWrite();
  });

  it("returns 409 display_name_mismatch for an explicit propertyId whose name does not match", async () => {
    listPropertiesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "ga4_acct_other",
          properties: [
            { propertyId: "properties/999", displayName: "Some other property" },
          ],
        },
      ]),
    );

    const res = await handlePost(
      post({ projectId: PROJECT_ID, propertyId: "properties/999" }, auth),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "display_name_mismatch",
      propertyId: "properties/999",
      displayName: "Some other property",
      domain: "example.com",
    });
    expectNoWrite();
  });

  it("returns 409 for an explicit id whose name does not match even when the body carries the exact real displayName", async () => {
    listPropertiesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "ga4_acct_other",
          properties: [
            { propertyId: "properties/999", displayName: "Some other property" },
          ],
        },
      ]),
    );

    const res = await handlePost(
      post(
        {
          projectId: PROJECT_ID,
          propertyId: "properties/999",
          displayName: "Some other property",
        },
        auth,
      ),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "display_name_mismatch",
      propertyId: "properties/999",
      displayName: "Some other property",
      domain: "example.com",
    });
    expectNoWrite();
  });

  it("returns 409 display_name_mismatch when the supplied displayName does not match", async () => {
    listPropertiesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "ga4_acct_other",
          properties: [
            { propertyId: "properties/999", displayName: "Some other property" },
          ],
        },
      ]),
    );

    const res = await handlePost(
      post(
        {
          projectId: PROJECT_ID,
          propertyId: "properties/999",
          displayName: "wrong name",
        },
        auth,
      ),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "display_name_mismatch",
      propertyId: "properties/999",
      displayName: "Some other property",
      domain: "example.com",
    });
    expectNoWrite();
  });

  it("returns 404 not_visible for an explicit propertyId outside the visible set", async () => {
    const res = await handlePost(
      post({ projectId: PROJECT_ID, propertyId: "properties/404" }, auth),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "property_not_visible",
      reason: "not_visible",
      candidates: [{ propertyId: PROPERTY_ID, displayName: "example.com" }],
    });
    expectNoWrite();
  });

  it("skips accounts flagged propertiesUnavailable", async () => {
    listPropertiesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "ga4_acct_broken",
          propertiesUnavailable: true,
          properties: [{ propertyId: PROPERTY_ID, displayName: "example.com" }],
        },
        {
          accountId: "ga4_acct_early",
          properties: [
            { propertyId: "properties/2", displayName: "other.com" },
          ],
        },
      ]),
    );

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "property_not_visible",
      reason: "no_match",
      candidates: [{ propertyId: "properties/2", displayName: "other.com" }],
    });
    expectNoWrite();
  });

  it("auto-picks the earliest holder account when the same propertyId is visible twice", async () => {
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
    listPropertiesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "acc-new",
          properties: [{ propertyId: PROPERTY_ID, displayName: "example.com" }],
        },
        {
          accountId: "acc-old",
          properties: [{ propertyId: PROPERTY_ID, displayName: "example.com" }],
        },
      ]),
    );

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(setProperty).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      organizationId: ORG_ID,
      propertyId: PROPERTY_ID,
      accountId: "acc-old",
      userId: "user_early",
    });
  });

  it("skips accounts that require reconnect", async () => {
    listPropertiesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "ga4_acct_stale",
          requiresReconnect: true,
          properties: [{ propertyId: PROPERTY_ID, displayName: "example.com" }],
        },
      ]),
    );

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: "property_not_visible",
      reason: "no_match",
      candidates: [],
    });
    expectNoWrite();
  });

  it("attaches successfully and passes the resolved organizationId", async () => {
    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      projectId: PROJECT_ID,
      propertyId: PROPERTY_ID,
      displayName: "example.com",
      connectedAt: CONNECTION.createdAt,
    });
    expect(setProperty).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      organizationId: ORG_ID,
      propertyId: PROPERTY_ID,
      accountId: "ga4_acct_early",
      userId: "user_early",
    });
  });

  it("maps setProperty NOT_FOUND to 404 property_not_visible service_rejected", async () => {
    setProperty.mockRejectedValueOnce(new AppError("NOT_FOUND", "missing"));

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "property_not_visible",
      reason: "service_rejected",
      candidates: [{ propertyId: PROPERTY_ID, displayName: "example.com" }],
    });
  });

  it("maps setProperty FORBIDDEN to 403 property_unverified", async () => {
    setProperty.mockRejectedValueOnce(new AppError("FORBIDDEN", "unverified"));

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "property_unverified" });
  });

  it("maps a generic setProperty error to 500 attach_failed", async () => {
    setProperty.mockRejectedValueOnce(new Error("ga4 down"));

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "attach_failed" });
  });
});
