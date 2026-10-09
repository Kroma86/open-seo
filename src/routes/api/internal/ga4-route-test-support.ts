import { expect, vi } from "vitest";
import type { Ga4Connection } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import type { Ga4Service } from "@/server/features/ga4/services/Ga4Service";
import type { ProjectService } from "@/server/features/projects/services/ProjectService";
import { AppError } from "@/server/lib/errors";
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

// Mocks and fixtures shared by the ga4*.test.ts files. Each test file wires
// these into its own vi.mock factories.

export const ga4Mocks = {
  listMembers: vi.fn<() => Promise<ActorRow[]>>(),
  listUsers: vi.fn<() => Promise<ActorRow[]>>(),
  listGrants: vi.fn<() => Promise<GrantRow[]>>(),
  getProjectForOrganization:
    vi.fn<(typeof ProjectService)["getProjectForOrganization"]>(),
  getConnection: vi.fn<(typeof Ga4Service)["getConnection"]>(),
  listPropertiesForUserWithGrantStatus:
    vi.fn<(typeof Ga4Service)["listPropertiesForUserWithGrantStatus"]>(),
  setProperty: vi.fn<(typeof Ga4Service)["setProperty"]>(),
};

export const { get, post } = requestBuilders(
  "http://localhost/api/internal/ga4",
);

export const PROPERTY_ID = "properties/123456";

export const EARLY_GRANT: GrantRow = {
  userId: "user_early",
  accountId: "ga4_acct_early",
  createdAt: new Date("2026-01-02T00:00:00.000Z"),
};

export const LATE_GRANT: GrantRow = {
  userId: "user_late",
  accountId: "ga4_acct_late",
  createdAt: new Date("2026-01-03T00:00:00.000Z"),
};

export const CONNECTION: Ga4Connection = {
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

export function listedAccounts(
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

export function expectNoWrite() {
  expect(ga4Mocks.setProperty).not.toHaveBeenCalled();
}

export function setGa4Defaults() {
  ga4Mocks.getProjectForOrganization.mockImplementation(
    async (_organizationId: string, projectId: string) => {
      if (projectId === PROJECT_ID) return PROJECT;
      throw new AppError("NOT_FOUND");
    },
  );
  ga4Mocks.listMembers.mockResolvedValue([LATE_MEMBER, EARLY_MEMBER]);
  ga4Mocks.listUsers.mockResolvedValue([LATE_MEMBER, EARLY_MEMBER]);
  ga4Mocks.listGrants.mockResolvedValue([EARLY_GRANT]);
  ga4Mocks.getConnection.mockResolvedValue(null);
  ga4Mocks.listPropertiesForUserWithGrantStatus.mockResolvedValue(
    listedAccounts([
      {
        accountId: "ga4_acct_early",
        properties: [{ propertyId: PROPERTY_ID, displayName: "example.com" }],
      },
    ]),
  );
  ga4Mocks.setProperty.mockResolvedValue(CONNECTION);
}
