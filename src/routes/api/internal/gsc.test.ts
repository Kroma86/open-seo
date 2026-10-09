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
  get,
  gscMocks,
  post,
  setGscDefaults,
  SITE_URL,
  SNAPSHOT,
} from "./gsc-route-test-support";
import {
  auth,
  EARLY_MEMBER,
  ORG_ID,
  PROJECT,
  PROJECT_ID,
  TOKEN,
} from "./internal-route-test-support";
import { handleGet, handlePost } from "./gsc";

const {
  listMembers,
  listUsers,
  listGrants,
  getProjectForOrganization,
  getConnection,
  listSitesForUserWithGrantStatus,
  setSite,
  loadGscTotals,
} = gscMocks;

beforeEach(() => {
  mockEnv.AGENCY_SCORE_EXPORT_TOKEN = TOKEN;
  delete mockEnv.AUTH_MODE;
  setGscDefaults();
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
    listUsers.mockResolvedValue([]);

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
    expect(listMembers).toHaveBeenCalled();
    expect(listUsers).not.toHaveBeenCalled();
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

  it("returns 200 idempotent when the requested URL differs only by a trailing slash", async () => {
    getConnection.mockResolvedValue({
      ...CONNECTION,
      siteUrl: "https://example.com",
    });

    const res = await handlePost(
      post({ projectId: PROJECT_ID, siteUrl: "https://example.com/" }, auth),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      projectId: PROJECT_ID,
      siteUrl: "https://example.com",
      connectedAt: CONNECTION.createdAt,
      snapshot: SNAPSHOT,
    });
    expectNoWrite();
    expect(listSitesForUserWithGrantStatus).not.toHaveBeenCalled();
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

  it("attaches using a deployment user when AUTH_MODE=cloudflare_access even with zero members", async () => {
    mockEnv.AUTH_MODE = "cloudflare_access";
    listMembers.mockResolvedValue([]);
    listUsers.mockResolvedValue([EARLY_MEMBER]);
    listGrants.mockResolvedValue([EARLY_GRANT]);

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(setSite).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      organizationId: ORG_ID,
      siteUrl: SITE_URL,
      accountId: "gsc_acct_early",
      userId: "user_early",
    });
    expect(listUsers).toHaveBeenCalled();
    expect(listMembers).not.toHaveBeenCalled();
  });

  it("returns 404 no_grant when AUTH_MODE=cloudflare_access and there are no users", async () => {
    mockEnv.AUTH_MODE = "cloudflare_access";
    listMembers.mockResolvedValue([EARLY_MEMBER]);
    listUsers.mockResolvedValue([]);
    listGrants.mockResolvedValue([EARLY_GRANT]);

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "property_not_visible",
      reason: "no_grant",
      candidates: [],
    });
    expect(listSitesForUserWithGrantStatus).not.toHaveBeenCalled();
    expectNoWrite();
    expect(listUsers).toHaveBeenCalled();
    expect(listMembers).not.toHaveBeenCalled();
  });

  it("attaches using a grant holder with a blank email under AUTH_MODE=cloudflare_access", async () => {
    mockEnv.AUTH_MODE = "cloudflare_access";
    listUsers.mockResolvedValue([{ ...EARLY_MEMBER, userEmail: "" }]);
    listGrants.mockResolvedValue([EARLY_GRANT]);

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(setSite).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_early",
        accountId: "gsc_acct_early",
      }),
    );
    expect(listUsers).toHaveBeenCalled();
    expect(listMembers).not.toHaveBeenCalled();
  });
});
