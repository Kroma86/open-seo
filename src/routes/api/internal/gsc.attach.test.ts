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

import { AppError } from "@/server/lib/errors";
import {
  CONNECTION,
  expectNoWrite,
  gscMocks,
  listedAccounts,
  post,
  setGscDefaults,
  SITE_URL,
  SNAPSHOT,
} from "./gsc-route-test-support";
import {
  auth,
  ORG_ID,
  PROJECT,
  PROJECT_ID,
  TOKEN,
} from "./internal-route-test-support";
import { handlePost } from "./gsc";

const {
  listGrants,
  getProjectForOrganization,
  listSitesForUserWithGrantStatus,
  setSite,
  loadGscTotals,
} = gscMocks;

beforeEach(() => {
  mockEnv.AGENCY_SCORE_EXPORT_TOKEN = TOKEN;
  delete mockEnv.AUTH_MODE;
  setGscDefaults();
});

describe("internal gsc handlePost explicit sites and attach", () => {
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
