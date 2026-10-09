import { expect, vi } from "vitest";
import type { loadGscTotals } from "@/server/features/agency/AgencyScoreInputsService";
import type { GscConnection } from "@/server/features/gsc/repositories/GscConnectionRepository";
import type { GscService } from "@/server/features/gsc/services/GscService";
import type { ProjectService } from "@/server/features/projects/services/ProjectService";
import { AppError } from "@/server/lib/errors";
import type { GscSite } from "@/server/lib/gscClient";
import {
  EARLY_MEMBER,
  LATE_MEMBER,
  ORG_ID,
  PROJECT,
  PROJECT_ID,
  requestBuilders,
  type ActorRow,
  type GrantRow,
} from "./internal-route-test-support";

// Mocks and fixtures shared by the gsc*.test.ts files. Each test file wires
// these into its own vi.mock factories.

export const gscMocks = {
  listMembers: vi.fn<() => Promise<ActorRow[]>>(),
  listUsers: vi.fn<() => Promise<ActorRow[]>>(),
  listGrants: vi.fn<() => Promise<GrantRow[]>>(),
  getProjectForOrganization:
    vi.fn<(typeof ProjectService)["getProjectForOrganization"]>(),
  getConnection: vi.fn<(typeof GscService)["getConnection"]>(),
  listSitesForUserWithGrantStatus:
    vi.fn<(typeof GscService)["listSitesForUserWithGrantStatus"]>(),
  setSite: vi.fn<(typeof GscService)["setSite"]>(),
  loadGscTotals: vi.fn<typeof loadGscTotals>(),
};

export const { get, post } = requestBuilders(
  "http://localhost/api/internal/gsc",
);

export const SITE_URL = "sc-domain:example.com";

export const EARLY_GRANT: GrantRow = {
  userId: "user_early",
  accountId: "gsc_acct_early",
  createdAt: new Date("2026-01-02T00:00:00.000Z"),
};

export const LATE_GRANT: GrantRow = {
  userId: "user_late",
  accountId: "gsc_acct_late",
  createdAt: new Date("2026-01-03T00:00:00.000Z"),
};

export const CONNECTION: GscConnection = {
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

export const SNAPSHOT: Awaited<ReturnType<typeof loadGscTotals>> = {
  clicks: 10,
  impressions: 100,
  ctr: 0.1,
  position: 5.2,
  windowStart: "2026-07-04",
  windowEnd: "2026-07-31",
  capturedAt: "2026-08-01",
  source: "google_search_console",
};

export function listedAccounts(
  accounts: Array<{
    accountId: string;
    requiresReconnect?: boolean;
    sites: GscSite[];
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

export function expectNoWrite() {
  expect(gscMocks.setSite).not.toHaveBeenCalled();
}

export function setGscDefaults() {
  gscMocks.getProjectForOrganization.mockImplementation(
    async (_organizationId: string, projectId: string) => {
      if (projectId === PROJECT_ID) return PROJECT;
      throw new AppError("NOT_FOUND");
    },
  );
  gscMocks.listMembers.mockResolvedValue([LATE_MEMBER, EARLY_MEMBER]);
  gscMocks.listUsers.mockResolvedValue([LATE_MEMBER, EARLY_MEMBER]);
  gscMocks.listGrants.mockResolvedValue([EARLY_GRANT]);
  gscMocks.getConnection.mockResolvedValue(null);
  gscMocks.listSitesForUserWithGrantStatus.mockResolvedValue(
    listedAccounts([
      {
        accountId: "gsc_acct_early",
        sites: [{ siteUrl: SITE_URL, permissionLevel: "siteFullUser" }],
      },
    ]),
  );
  gscMocks.setSite.mockResolvedValue(CONNECTION);
  gscMocks.loadGscTotals.mockResolvedValue(SNAPSHOT);
}
