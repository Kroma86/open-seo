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

import { AppError } from "@/server/lib/errors";
import {
  CONNECTION,
  expectNoWrite,
  ga4Mocks,
  listedAccounts,
  post,
  PROPERTY_ID,
  setGa4Defaults,
} from "./ga4-route-test-support";
import { auth, ORG_ID, PROJECT_ID, TOKEN } from "./internal-route-test-support";
import { handlePost } from "./ga4";

const { listGrants, listPropertiesForUserWithGrantStatus, setProperty } =
  ga4Mocks;

beforeEach(() => {
  mockEnv.AGENCY_SCORE_EXPORT_TOKEN = TOKEN;
  delete mockEnv.AUTH_MODE;
  setGa4Defaults();
});

describe("internal ga4 handlePost explicit ids and attach", () => {
  it("returns 409 display_name_mismatch when the supplied displayName does not match", async () => {
    listPropertiesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "ga4_acct_other",
          properties: [
            {
              propertyId: "properties/999",
              displayName: "Some other property",
            },
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

  it("returns 409 display_name_mismatch for an explicit propertyId with a business-name display and no override flag", async () => {
    listPropertiesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "ga4_acct_early",
          properties: [
            {
              propertyId: "properties/777",
              displayName: "AP Hurley Construction",
            },
          ],
        },
      ]),
    );

    const res = await handlePost(
      post({ projectId: PROJECT_ID, propertyId: "properties/777" }, auth),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "display_name_mismatch",
      propertyId: "properties/777",
      displayName: "AP Hurley Construction",
      domain: "example.com",
    });
    expectNoWrite();
  });

  it("attaches an explicit mismatched-name property when acceptDisplayNameMismatch is true", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      listPropertiesForUserWithGrantStatus.mockResolvedValue(
        listedAccounts([
          {
            accountId: "ga4_acct_early",
            properties: [
              {
                propertyId: "properties/777",
                displayName: "AP Hurley Construction",
              },
            ],
          },
        ]),
      );
      setProperty.mockResolvedValue({
        ...CONNECTION,
        propertyId: "properties/777",
        propertyDisplayName: "AP Hurley Construction",
      });

      const res = await handlePost(
        post(
          {
            projectId: PROJECT_ID,
            propertyId: "properties/777",
            acceptDisplayNameMismatch: true,
          },
          auth,
        ),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        projectId: PROJECT_ID,
        propertyId: "properties/777",
        displayName: "AP Hurley Construction",
        connectedAt: CONNECTION.createdAt,
        displayNameMismatchAccepted: true,
      });
      expect(setProperty).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        organizationId: ORG_ID,
        propertyId: "properties/777",
        accountId: "ga4_acct_early",
        userId: "user_early",
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`projectId=${PROJECT_ID}`),
      );
      expect(warn.mock.calls[0]?.[0]).toContain("properties/777");
      expect(warn.mock.calls[0]?.[0]).toContain("AP Hurley Construction");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not auto-pick a mismatched-name candidate even when acceptDisplayNameMismatch is true", async () => {
    listPropertiesForUserWithGrantStatus.mockResolvedValue(
      listedAccounts([
        {
          accountId: "ga4_acct_early",
          properties: [
            {
              propertyId: "properties/777",
              displayName: "AP Hurley Construction",
            },
          ],
        },
      ]),
    );

    const res = await handlePost(
      post({ projectId: PROJECT_ID, acceptDisplayNameMismatch: true }, auth),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "property_not_visible",
      reason: "no_match",
      candidates: [
        {
          propertyId: "properties/777",
          displayName: "AP Hurley Construction",
        },
      ],
    });
    expectNoWrite();
  });

  it("returns 404 not_visible for an explicit id outside the visible set even when acceptDisplayNameMismatch is true", async () => {
    const res = await handlePost(
      post(
        {
          projectId: PROJECT_ID,
          propertyId: "properties/404",
          acceptDisplayNameMismatch: true,
        },
        auth,
      ),
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
