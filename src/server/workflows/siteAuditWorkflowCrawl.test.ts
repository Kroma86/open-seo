import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrawledPageResult } from "@/server/lib/audit/types";

const mocks = vi.hoisted(() => ({
  claimChunk: vi.fn(),
  getStats:
    vi.fn<
      () => Promise<{ attempted: number; pending: number; seen: number }>
    >(),
  recordBatch: vi.fn(),
  releaseUrls: vi.fn<(urls: string[]) => Promise<void>>(),
  insertCrawledBatch: vi.fn(),
  pgStep: vi.fn(),
}));
vi.mock("@/server/features/audit/AuditScratchpad", () => ({
  getAuditScratchpad: () => mocks,
}));
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {
    insertCrawledBatch: mocks.insertCrawledBatch,
    updateAuditProgress: vi.fn(),
  },
}));
vi.mock("@/server/lib/audit/progress-kv", () => ({
  AuditProgressKV: { pushCrawledUrls: vi.fn() },
}));
vi.mock("@/server/workflows/pgStep", () => ({ pgStep: mocks.pgStep }));
vi.mock("@/server/lib/audit/ids", () => ({
  deterministicAuditRowId: async (_auditId: string, url: string) => url,
  sha256Hex: async () => "content-hash",
}));

import { runCrawlPhase } from "@/server/workflows/siteAuditWorkflowCrawl";
import { parseRobotsTxt } from "@/server/lib/audit/discovery";

const ORIGIN = "https://example.com";
const HTML = "<html><title>A page</title><body><h1>A page</h1></body></html>";
let saved: CrawledPageResult[];

beforeEach(async () => {
  // Load the lazy HTML parser before advancing the fake network clock.
  await import("@/server/lib/audit/page-analyzer");
  vi.useFakeTimers();
  vi.setSystemTime(0);
  saved = [];
  mocks.pgStep.mockImplementation((_step, _name, _config, fn: () => unknown) =>
    fn(),
  );
  mocks.claimChunk.mockImplementation(
    async (_chunk: number, limit: number) => ({
      urls: Array.from({ length: limit }, (_, i) => ({
        url: `${ORIGIN}/${i}`,
        depth: 0,
        inSitemap: true,
      })),
      isRetry: false,
    }),
  );
  mocks.getStats.mockImplementation(async () => ({
    attempted: saved.length,
    pending: 100 - saved.length,
    seen: 100,
  }));
  mocks.recordBatch.mockImplementation(() => mocks.getStats());
  mocks.insertCrawledBatch.mockImplementation(
    async (_audit, pages: CrawledPageResult[]) => {
      saved.push(...pages);
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function crawl(maxPages = 100) {
  return runCrawlPhase(
    { do: vi.fn(), sleep: vi.fn(), sleepUntil: vi.fn(), waitForEvent: vi.fn() },
    {
      auditId: "audit",
      workflowInstanceId: "workflow",
      origin: ORIGIN,
      maxPages,
      seededCount: maxPages,
      robots: parseRobotsTxt("", ORIGIN),
    },
  );
}

function serve(status: (now: number) => number, retryAfter?: string) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    // Network responses settle after all requests in the window are launched.
    await new Promise((resolve) => setTimeout(resolve, 1));
    return new Response(HTML, {
      status: status(Date.now()),
      headers: {
        "content-type": "text/html",
        ...(retryAfter ? { "retry-after": retryAfter } : {}),
      },
    });
  });
}

describe("crawl rate-limit budget", () => {
  it("honors the final URL's cooldown before starting the next chunk", async () => {
    const total = 210;
    mocks.claimChunk.mockImplementation(
      async (chunk: number, limit: number) => ({
        urls: Array.from({ length: limit }, (_, i) => ({
          url: `${ORIGIN}/${(chunk - 1) * 200 + i}`,
          depth: 0,
          inSitemap: true,
        })),
        isRetry: false,
      }),
    );
    mocks.getStats.mockImplementation(async () => ({
      attempted: saved.length,
      pending: total - saved.length,
      seen: total,
    }));
    let lastRefusalAt = 0;
    let nextChunkStartedAt = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new Request(input).url;
      if (url === `${ORIGIN}/200`) nextChunkStartedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 1));
      const refused = url === `${ORIGIN}/199`;
      if (refused) lastRefusalAt = Date.now();
      return new Response(HTML, {
        status: refused ? 429 : 200,
        headers: { "content-type": "text/html", "retry-after": "5" },
      });
    });

    const result = crawl(total);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toEqual({ pagesCrawled: total, completed: true });
    expect(mocks.claimChunk).toHaveBeenCalledTimes(2);
    expect(lastRefusalAt).toBeGreaterThan(0);
    expect(nextChunkStartedAt - lastRefusalAt).toBeGreaterThanOrEqual(5_000);
  });

  it("finishes all pages after a sixty-second origin cooldown", async () => {
    const fetchMock = serve((now) => (now < 60_000 ? 429 : 200), "60");
    const result = crawl();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual({ pagesCrawled: 100, completed: true });
    expect(saved.every((page) => page.fetchClass === "ok")).toBe(true);
    expect(mocks.claimChunk).toHaveBeenCalledTimes(1);
  });

  it("stops a permanently limited origin without restarting in another chunk", async () => {
    const fetchMock = serve(() => 429);
    const result = crawl();
    await vi.advanceTimersByTimeAsync(100_000);
    const outcome = await result;
    expect(outcome).toMatchObject({ completed: false, rateLimited: true });
    expect(outcome.pagesCrawled).toBeLessThan(100);
    expect(fetchMock.mock.calls.length).toBeLessThan(400);
    expect(saved.every((page) => page.fetchClass === "rate_limited")).toBe(
      true,
    );
    expect(mocks.claimChunk).toHaveBeenCalledTimes(1);
    expect(mocks.releaseUrls).toHaveBeenCalledTimes(1);
    expect(mocks.releaseUrls.mock.calls[0][0].length).toBe(100 - saved.length);
  });

  it("leaves URLs unvisited when Retry-After is longer than the entire budget", async () => {
    const fetchMock = serve(() => 429, "600");
    const result = crawl();
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toEqual({
      pagesCrawled: 10,
      completed: false,
      rateLimited: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(mocks.releaseUrls.mock.calls[0][0]).toHaveLength(90);
    expect(mocks.claimChunk).toHaveBeenCalledTimes(1);
  });
});
