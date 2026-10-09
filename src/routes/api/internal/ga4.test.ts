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
  const { ga4Mocks } = await import("./ga4-route-test-support");
  return { db: createActorDb(ga4Mocks) };
});

vi.mock("@/server/features/projects/services/ProjectService", async () => {
  const { ga4Mocks } = await import("./ga4-route-test-support");
  return {
    ProjectService: {
      getProjectForOrganization: ga4Mocks.getProjectForOrganization,
    },
  };
});

vi.mock("@/server/features/ga4/services/Ga4Service", async () => {
  const { ga4Mocks } = await import("./ga4-route-test-support");
  return {
    Ga4Service: {
      getConnection: ga4Mocks.getConnection,
      listPropertiesForUserWithGrantStatus:
        ga4Mocks.listPropertiesForUserWithGrantStatus,
      setProperty: ga4Mocks.setProperty,
    },
  };
});

import {
  CONNECTION,
  EARLY_GRANT,
  expectNoWrite,
  ga4Mocks,
  get,
  LATE_GRANT,
  post,
  PROPERTY_ID,
  setGa4Defaults,
} from "./ga4-route-test-support";
import {
  auth,
  EARLY_MEMBER,
  LATE_MEMBER,
  ORG_ID,
  PROJECT,
  PROJECT_ID,
  TOKEN,
} from "./internal-route-test-support";
import { handleGet, handlePost } from "./ga4";

const {
  listMembers,
  listUsers,
  listGrants,
  getProjectForOrganization,
  getConnection,
  listPropertiesForUserWithGrantStatus,
  setProperty,
} = ga4Mocks;

beforeEach(() => {
  mockEnv.AGENCY_SCORE_EXPORT_TOKEN = TOKEN;
  delete mockEnv.AUTH_MODE;
  setGa4Defaults();
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
    listUsers.mockResolvedValue([]);

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
    expect(listMembers).toHaveBeenCalled();
    expect(listUsers).not.toHaveBeenCalled();
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

  it("attaches using a deployment user when AUTH_MODE=cloudflare_access even with zero members", async () => {
    mockEnv.AUTH_MODE = "cloudflare_access";
    listMembers.mockResolvedValue([]);
    listUsers.mockResolvedValue([EARLY_MEMBER]);
    listGrants.mockResolvedValue([EARLY_GRANT]);

    const res = await handlePost(post({ projectId: PROJECT_ID }, auth));
    expect(res.status).toBe(200);
    expect(setProperty).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      organizationId: ORG_ID,
      propertyId: PROPERTY_ID,
      accountId: "ga4_acct_early",
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
    expect(listPropertiesForUserWithGrantStatus).not.toHaveBeenCalled();
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
    expect(setProperty).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_early",
        accountId: "ga4_acct_early",
      }),
    );
    expect(listUsers).toHaveBeenCalled();
    expect(listMembers).not.toHaveBeenCalled();
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
});
