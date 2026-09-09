import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type * as Ga4ConnectionRepositoryModule from "./Ga4ConnectionRepository";

// Real in-memory SQLite: which grants the correlated DELETE keeps is the whole
// contract here and a mocked builder chain can't see it. The dynamic import is
// needed so the repository binds to the test db instead of the real one.

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
}));

let client: Client;
let Ga4ConnectionRepository: typeof Ga4ConnectionRepositoryModule.Ga4ConnectionRepository;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  vi.doMock("@/db", () => ({ db: drizzle(client) }));
  await client.executeMultiple(`
    CREATE TABLE ga4_connections (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL,
      connected_by_user_id text NOT NULL,
      ga4_account_id text NOT NULL
    );
    CREATE TABLE account (
      id text PRIMARY KEY NOT NULL,
      account_id text NOT NULL,
      provider_id text NOT NULL,
      user_id text NOT NULL
    );
    -- bystander: their own project uses the same Google sub as u1's unused
    -- grant. stranger: a grant no project uses, which only the user filter protects.
    INSERT INTO ga4_connections (id, project_id, connected_by_user_id, ga4_account_id)
      VALUES ('c1', 'p1', 'u1', 'sub-used'),
             ('c2', 'p2', 'bystander', 'sub-unused');
    INSERT INTO account (id, user_id, provider_id, account_id) VALUES
      ('g1', 'u1', 'google-analytics', 'sub-used'),
      ('g2', 'u1', 'google-analytics', 'sub-unused'),
      ('g3', 'u1', 'google-search-console', 'sub-unused'),
      ('g4', 'bystander', 'google-analytics', 'sub-unused'),
      ('g5', 'stranger', 'google-analytics', 'sub-idle');
    INSERT INTO account (id, user_id, provider_id, account_id)
      VALUES ('pending', 'u1', 'google-analytics', 'sub-other-pending');
  `);
  ({ Ga4ConnectionRepository } = await import("./Ga4ConnectionRepository"));
});

afterAll(() => {
  client.close();
});

it("deletes only the caller's Analytics grants that no project of theirs uses", async () => {
  await Ga4ConnectionRepository.deleteUnusedGrant("u1", "sub-unused");

  const { rows } = await client.execute(
    "SELECT user_id, provider_id, account_id FROM account ORDER BY user_id, provider_id, account_id",
  );
  expect(
    rows.map((row) => [row.user_id, row.provider_id, row.account_id]),
  ).toEqual([
    ["bystander", "google-analytics", "sub-unused"],
    ["stranger", "google-analytics", "sub-idle"],
    ["u1", "google-analytics", "sub-other-pending"],
    ["u1", "google-analytics", "sub-used"],
    ["u1", "google-search-console", "sub-unused"],
  ]);
});

it("does not remove an account a saved project still uses", async () => {
  await expect(
    Ga4ConnectionRepository.deleteUnusedGrant("u1", "sub-used"),
  ).resolves.toBe(false);
});
