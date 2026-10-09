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
  LATE_GRANT,
  listedAccounts,
  post,
  PROPERTY_ID,
  setGa4Defaults,
} from "./ga4-route-test-support";
import {
  auth,
  ORG_ID,
  PROJECT,
  PROJECT_ID,
  TOKEN,
} from "./internal-route-test-support";
import { handlePost } from "./ga4";

const {
  listGrants,
  getProjectForOrganization,
  listPropertiesForUserWithGrantStatus,
  setProperty,
} = ga4Mocks;

beforeEach(() => {
  mockEnv.AGENCY_SCORE_EXPORT_TOKEN = TOKEN;
  delete mockEnv.AUTH_MODE;
  setGa4Defaults();
});

describe("internal ga4 handlePost property matching", () => {
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
            properties: [
              { propertyId: PROPERTY_ID, displayName: "example.com" },
            ],
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
  ])(
    "auto-picks a display name that matches (%s)",
    async (_label, displayName) => {
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
    },
  );

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
  ])(
    "does not match a near-miss display name (%s)",
    async (_label, displayName) => {
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
    },
  );

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
            {
              propertyId: "properties/999",
              displayName: "Some other property",
            },
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
});
