import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type * as GscConnectionRepositoryModule from "./GscConnectionRepository";

// Real in-memory SQLite: which grants the correlated DELETE keeps is the whole
// contract here and a mocked builder chain can't see it. The dynamic import is
// needed so the repository binds to the test db instead of the real one.

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
}));

let client: Client;
let GscConnectionRepository: typeof GscConnectionRepositoryModule.GscConnectionRepository;

async function grants() {
  const { rows } = await client.execute(
    "SELECT user_id, provider_id, account_id FROM account ORDER BY user_id, provider_id, account_id",
  );
  return rows.map((row) => [row.user_id, row.provider_id, row.account_id]);
}

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  vi.doMock("@/db", () => ({ db: drizzle(client) }));
  await client.executeMultiple(`
    CREATE TABLE gsc_connections (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL,
      organization_id text NOT NULL,
      site_url text NOT NULL,
      connected_by_user_id text NOT NULL,
      connected_account_email text,
      gsc_account_id text,
      created_at text DEFAULT (current_timestamp) NOT NULL,
      updated_at text DEFAULT (current_timestamp) NOT NULL
    );
    CREATE TABLE account (
      id text PRIMARY KEY NOT NULL,
      account_id text NOT NULL,
      provider_id text NOT NULL,
      user_id text NOT NULL
    );
    -- legacy: connected before gsc_account_id existed. bystander: their own
    -- project uses the same Google sub as u1's unused grant. stranger: a grant
    -- no project uses, which only the user filter protects.
    INSERT INTO gsc_connections (id, project_id, organization_id, site_url, connected_by_user_id, gsc_account_id)
      VALUES ('c1', 'p1', 'o1', 'https://a.example/', 'legacy', NULL),
             ('c2', 'p2', 'o1', 'https://b.example/', 'u1', 'sub-used'),
             ('c3', 'p3', 'o2', 'https://c.example/', 'bystander', 'sub-unused');
    INSERT INTO account (id, user_id, provider_id, account_id) VALUES
      ('g1', 'legacy', 'google-search-console', 'sub-a'),
      ('g2', 'legacy', 'google-search-console', 'sub-b'),
      ('g3', 'u1', 'google-search-console', 'sub-used'),
      ('g4', 'u1', 'google-search-console', 'sub-unused'),
      ('g5', 'u1', 'google-analytics', 'sub-unused'),
      ('g6', 'bystander', 'google-search-console', 'sub-unused'),
      ('g7', 'stranger', 'google-search-console', 'sub-idle');
    INSERT INTO account (id, user_id, provider_id, account_id)
      VALUES ('pending', 'u1', 'google-search-console', 'sub-other-pending');
  `);
  ({ GscConnectionRepository } = await import("./GscConnectionRepository"));
});

afterAll(() => {
  client.close();
});

it("deletes only the caller's Search Console grants that no project of theirs uses", async () => {
  await GscConnectionRepository.deleteUnusedGrant("u1", "sub-unused");

  await expect(grants()).resolves.toEqual([
    ["bystander", "google-search-console", "sub-unused"],
    ["legacy", "google-search-console", "sub-a"],
    ["legacy", "google-search-console", "sub-b"],
    ["stranger", "google-search-console", "sub-idle"],
    ["u1", "google-analytics", "sub-unused"],
    ["u1", "google-search-console", "sub-other-pending"],
    ["u1", "google-search-console", "sub-used"],
  ]);
});

it("treats a legacy connection with no bound account as using every grant", async () => {
  await GscConnectionRepository.deleteUnusedGrant("legacy", "sub-a");

  await expect(grants()).resolves.toEqual(
    expect.arrayContaining([
      ["legacy", "google-search-console", "sub-a"],
      ["legacy", "google-search-console", "sub-b"],
    ]),
  );
});

it("does not remove an account a saved project still uses", async () => {
  await expect(
    GscConnectionRepository.deleteUnusedGrant("u1", "sub-used"),
  ).resolves.toBe(false);
});
