import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  onConflictDoNothing: vi.fn(),
  where: vi.fn(),
  ensureSharedOrg: vi.fn(),
  // Returns what it was given so a test can read the clause back. A bare
  // sentinel makes every eq() call look identical, and this file has to
  // tell the row LOOKUP apart from the re-stamp's own where.
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  // Captured rows, declared up front so the shape is typed rather than
  // attached ad hoc (tsc rejects properties that appear only at runtime).
  insertedRow: undefined as { id: string; email: string } | undefined,
  updatedRow: undefined as { email: string } | undefined,
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("drizzle-orm", () => ({ eq: mocks.eq }));
vi.mock("@/db/schema", () => ({ user: { id: "user.id" } }));
vi.mock("@/db", () => ({
  db: {
    query: { user: { findFirst: mocks.findFirst } },
    insert: () => ({
      values: (row: unknown) => {
        mocks.insertedRow = row as { id: string; email: string };
        return { onConflictDoNothing: mocks.onConflictDoNothing };
      },
    }),
    // An existing row whose address differs is re-stamped rather than
    // duplicated, so the mock has to offer the update chain too.
    update: () => ({
      set: (row: unknown) => {
        mocks.updatedRow = row as { email: string };
        return { where: mocks.where };
      },
    }),
  },
}));
vi.mock("@/server/auth/delegated-organization", () => ({
  ensureSharedWorkspaceOrganization: mocks.ensureSharedOrg,
  ensureDelegatedOrganizationForUser: vi.fn(),
}));

const { resolveServiceTokenWorkspaceContext } = await import("./delegated");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findFirst.mockResolvedValue(undefined);
  mocks.onConflictDoNothing.mockResolvedValue(undefined);
  mocks.where.mockResolvedValue(undefined);
  mocks.ensureSharedOrg.mockResolvedValue("shared-org");
});

describe("resolveServiceTokenWorkspaceContext", () => {
  it("puts the machine in the SAME shared workspace people use, under its own identity", async () => {
    const context = await resolveServiceTokenWorkspaceContext("grok-bot.access");

    // The shared org is the point: a scheduled job and the person reading its
    // output must see one set of projects, not two.
    expect(mocks.ensureSharedOrg).toHaveBeenCalledTimes(1);
    expect(context.organizationId).toBe("shared-org");
    expect(context.userId).toBe("cf-service-token:grok-bot.access");
    expect(context.userEmail).toMatch(
      /^[0-9a-f]{40}@service-token\.invalid$/,
    );
  });

  it("creates the machine's row with the unroutable address, never a real one", async () => {
    await resolveServiceTokenWorkspaceContext("grok-bot.access");

    const row = mocks.insertedRow;
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.id).toBe("cf-service-token:grok-bot.access");
    expect(row.email.endsWith("@service-token.invalid")).toBe(true);
  });

  it("reuses an existing row instead of inserting a second one for the same token", async () => {
    mocks.findFirst.mockResolvedValue({ email: "already@service-token.invalid" });

    const context = await resolveServiceTokenWorkspaceContext("grok-bot.access");

    // Read the LOOKUP's own where clause. Asserting that eq() was called with
    // the id somewhere would also pass if the row were fetched by email and
    // only the re-stamp below keyed on id -- this fixture runs both.
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          column: "user.id",
          value: "cf-service-token:grok-bot.access",
        },
      }),
    );
    expect(mocks.onConflictDoNothing).not.toHaveBeenCalled();
    expect(context.userId).toBe("cf-service-token:grok-bot.access");
    // A row carrying a stale address is re-stamped with the derived one, so a
    // machine cannot keep an address that no longer matches its token.
    expect(mocks.updatedRow?.email).toBe(context.userEmail);
  });

  it("gives two tokens that a character map would have merged two different rows", async () => {
    const a = await resolveServiceTokenWorkspaceContext("ci-bot");
    const b = await resolveServiceTokenWorkspaceContext("CI-BOT");

    expect(a.userId).not.toBe(b.userId);
    expect(a.userEmail).not.toBe(b.userEmail);
  });
});
