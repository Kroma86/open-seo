import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  rejections: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({ env: { KV: mocks } }));
vi.mock("./repositories/ProposalRejectionsRepository", () => ({
  ProposalRejectionsRepository: { findByIds: mocks.rejections },
}));
import { readProposalInventoryPage } from "./ProposalInventoryService";
import { proposalPayloadHash } from "./ProposalRejectionService";

const prefix = "homegrown-otto:proposal:";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (n = 1) => ({
  id: id(n),
  domain: "example.test",
  path: "/",
  status: "pending",
  fixes: { title: "Private copy" },
  before: { title: "Old copy" },
});
const stream = (value: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
const page = (ids: string[], complete = true, cursor = "next") => ({
  keys: ids.map((value) => ({ name: prefix + value })),
  list_complete: complete,
  cursor,
});

describe("read-only complete proposal inventory pages", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.list.mockResolvedValue(page([id(1)]));
    mocks.get.mockImplementation(async () => stream(JSON.stringify(row())));
    mocks.rejections.mockResolvedValue([]);
  });

  it("enumerates the namespace prefix without reading the shortened index or exposing copy", async () => {
    const result = await readProposalInventoryPage(null);
    expect(mocks.list).toHaveBeenCalledWith({ prefix, limit: 100 });
    expect(mocks.get).toHaveBeenCalledWith(prefix + id(1), { type: "stream" });
    expect(result).toMatchObject({
      schema: "otto-inventory-page/1",
      scope: "all_proposal_keys",
      consistency: "eventual_not_atomic",
      list_complete: true,
      next_cursor: null,
      count: 1,
    });
    expect(result.records[0]).toMatchObject({
      id: id(1),
      fields: ["title"],
      status: "pending",
      rejection_request_id: null,
    });
    expect(JSON.stringify(result)).not.toContain("Private copy");
    expect(JSON.stringify(result)).not.toContain("Old copy");
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("preserves prefix and cursor on an empty nonfinal page", async () => {
    mocks.list.mockResolvedValue(page([], false, "next-2"));
    const result = await readProposalInventoryPage("next-1");
    expect(mocks.list).toHaveBeenCalledWith({
      prefix,
      limit: 100,
      cursor: "next-1",
    });
    expect(result).toMatchObject({
      count: 0,
      list_complete: false,
      request_cursor: "next-1",
      next_cursor: "next-2",
    });
  });

  it("reads all 100 keys using rejection lookups under their 75-ID limit", async () => {
    const ids = Array.from({ length: 100 }, (_, n) => id(n));
    mocks.list.mockResolvedValue(page(ids, false));
    mocks.get.mockImplementation(async (key: string) =>
      stream(JSON.stringify({ ...row(), id: key.slice(prefix.length) })),
    );
    const result = await readProposalInventoryPage(null);
    expect(result.count).toBe(100);
    expect(result.list_complete).toBe(false);
    expect(mocks.rejections.mock.calls.every(([ids]) => ids.length <= 75)).toBe(
      true,
    );
  });

  it("applies immutable rejection status only to its exact payload", async () => {
    const hash = await proposalPayloadHash(row());
    mocks.rejections.mockResolvedValue([
      {
        proposalId: id(1),
        domain: "example.test",
        path: "/",
        payloadHash: hash,
        requestId: id(8),
      },
    ]);
    expect((await readProposalInventoryPage(null)).records[0]).toMatchObject({
      status: "rejected",
      rejection_request_id: id(8),
    });
    mocks.rejections.mockResolvedValue([
      {
        proposalId: id(1),
        domain: "example.test",
        path: "/",
        payloadHash: "f".repeat(64),
        requestId: id(8),
      },
    ]);
    await expect(readProposalInventoryPage(null)).rejects.toThrow(
      "inventory_unavailable",
    );
  });

  it.each([
    "missing",
    "json",
    "identity",
    "status",
    "fixes",
    "domain",
    "oversized",
  ])("rejects %s records instead of dropping them", async (kind) => {
    const value = row() as Record<string, unknown>;
    if (kind === "identity") value.id = id(2);
    if (kind === "status") value.status = "accepted";
    if (kind === "fixes") value.fixes = { title: "" };
    if (kind === "domain") value.domain = "https://other.test";
    mocks.get.mockImplementation(async () =>
      kind === "missing"
        ? null
        : stream(
            kind === "json"
              ? "{"
              : kind === "oversized"
                ? "x".repeat(65537)
                : JSON.stringify(value),
          ),
    );
    await expect(readProposalInventoryPage(null)).rejects.toThrow();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it.each(["duplicate", "order", "prefix", "cursor", "unknown_complete"])(
    "rejects %s list evidence",
    async (kind) => {
      const result: Record<string, unknown> = page([id(1), id(2)], false);
      if (kind === "duplicate") result.keys = page([id(1), id(1)]).keys;
      if (kind === "order") result.keys = page([id(2), id(1)]).keys;
      if (kind === "prefix") result.keys = [{ name: "other:" + id(1) }];
      if (kind === "cursor") result.cursor = "current";
      if (kind === "unknown_complete") result.list_complete = undefined;
      mocks.list.mockResolvedValue(result);
      await expect(readProposalInventoryPage("current")).rejects.toThrow(
        "inventory_unavailable",
      );
    },
  );

  it.each(["", " ", "x".repeat(4097)])(
    "rejects invalid cursor before storage access",
    async (cursor) => {
      await expect(readProposalInventoryPage(cursor)).rejects.toMatchObject({
        status: 400,
      });
      expect(mocks.list).not.toHaveBeenCalled();
    },
  );
});
