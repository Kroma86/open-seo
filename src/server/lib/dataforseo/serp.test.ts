import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
}));

import {
  buildRankCheckResult,
  fetchRankCheckSerp,
  fetchRankCheckTaskResult,
  postRankCheckTasks,
  type SerpLiveItem,
} from "@/server/lib/dataforseo/serp";

function parseDataforseoRequestBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("Expected DataForSEO request body to be a string");
  }
  return JSON.parse(body) as unknown;
}

describe("rank check task queue", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("posts queued tasks, maps ids by tag, and sums cost over all entries", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [
          {
            id: "task-a",
            status_code: 20100,
            cost: 0.0006,
            data: { tag: "kw-1:desktop" },
          },
          {
            id: "task-b",
            status_code: 20100,
            cost: 0.0006,
            data: { tag: "kw-1:mobile" },
          },
          {
            id: "task-c",
            status_code: 40006,
            status_message: "Task Limit Exceeded",
            cost: 0.0006,
            data: { tag: "kw-2:desktop" },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await postRankCheckTasks({
      tasks: [
        { keyword: "alpha", keywordId: "kw-1", device: "desktop" },
        { keyword: "alpha", keywordId: "kw-1", device: "mobile" },
        { keyword: "beta", keywordId: "kw-2", device: "desktop" },
      ],
      locationCode: 2840,
      languageCode: "en",
      depth: 20,
      targetDomain: "example.com",
    });

    expect(
      fetchMock.mock.calls.map(([url]) =>
        typeof url === "string" || url instanceof URL
          ? url.toString()
          : url.url,
      ),
    ).toEqual(["https://api.dataforseo.com/v3/serp/google/organic/task_post"]);

    // Every posted task asks DataForSEO to stop crawling at the target's
    // organic listing — that is what cuts the actual crawl cost for ranking
    // domains without false "not ranking" stops on sitelinks/PAA mentions.
    const stopCrawl = {
      stop_crawl_on_match: [
        { match_value: "example.com", match_type: "with_subdomains" },
      ],
      find_targets_in: ["organic"],
    };
    expect(
      parseDataforseoRequestBody(fetchMock.mock.calls[0]?.[1]),
    ).toMatchObject([stopCrawl, stopCrawl, stopCrawl]);
    // Only desktop checks pay the async AI Overview fee, which is what
    // returns the overview's cited references.
    expect(parseDataforseoRequestBody(fetchMock.mock.calls[0]?.[1])).toMatchObject([
      { load_async_ai_overview: true },
      { load_async_ai_overview: false },
      { load_async_ai_overview: true },
    ]);
    expect(result.data).toEqual([
      {
        keyword: "alpha",
        keywordId: "kw-1",
        device: "desktop",
        taskId: "task-a",
      },
      {
        keyword: "alpha",
        keywordId: "kw-1",
        device: "mobile",
        taskId: "task-b",
      },
    ]);
    // The rejected entry's cost is still metered: a charge is a charge.
    expect(result.billing.costUsd).toBeCloseTo(0.0018, 10);
    expect(result.billing.path).toEqual([
      "v3",
      "serp",
      "google",
      "organic",
      "task_post",
    ]);
  });

  it("reports a queued task still in progress as pending", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [{ id: "task-a", status_code: 40602 }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await fetchRankCheckTaskResult({
      taskId: "task-a",
      keywordId: "kw-1",
      keyword: "alpha",
      targetDomain: "example.com",
    });

    expect(outcome).toEqual({ status: "pending" });
  });

  it("parses a completed queued task into a rank check result", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [
          {
            id: "task-a",
            status_code: 20000,
            cost: 0,
            path: ["v3", "serp", "google", "organic", "task_get", "advanced"],
            result: [
              {
                items: [
                  {
                    type: "organic",
                    rank_group: 3,
                    rank_absolute: 4,
                    domain: "www.example.com",
                    url: "https://www.example.com/page",
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await fetchRankCheckTaskResult({
      taskId: "task-a",
      keywordId: "kw-1",
      keyword: "alpha",
      targetDomain: "example.com",
    });

    expect(outcome).toEqual({
      status: "completed",
      result: {
        keywordId: "kw-1",
        keyword: "alpha",
        position: 3,
        url: "https://www.example.com/page",
        serpFeatures: ["organic"],
      },
    });
  });
});

function overview(extra: Record<string, unknown>): SerpLiveItem {
  return { type: "ai_overview", ...extra } as SerpLiveItem;
}

describe("buildRankCheckResult AI Overview citation", () => {
  const input = {
    keywordId: "kw-1",
    keyword: "alpha",
    targetDomain: "example.com",
  };

  it("flags a citation in the overview's top-level references, once", () => {
    const result = buildRankCheckResult(input, [
      { type: "organic", rank_group: 4, domain: "other.com" },
      overview({
        references: [
          { domain: "Example.com", url: "https://example.com/a" },
          { domain: "example.com" },
        ],
      }),
    ]);
    expect(result.serpFeatures).toEqual([
      "organic",
      "ai_overview",
      "ai_overview_cited",
    ]);

    const wwwTarget = buildRankCheckResult(
      { ...input, targetDomain: "www.example.com" },
      [overview({ references: [{ domain: "example.com" }] })],
    );
    expect(wwwTarget.serpFeatures).toContain("ai_overview_cited");
  });

  it("flags a citation on a nested overview element", () => {
    const result = buildRankCheckResult(input, [
      overview({
        items: [{ references: [{ domain: "example.com" }] }],
      }),
    ]);
    expect(result.serpFeatures).toEqual(["ai_overview", "ai_overview_cited"]);
  });

  it("matches a url-only reference by hostname", () => {
    const result = buildRankCheckResult(input, [
      overview({
        references: [{ url: "https://www.example.com/page" }],
      }),
    ]);
    expect(result.serpFeatures).toContain("ai_overview_cited");
  });

  it("checks the url when the reference domain is someone else", () => {
    const result = buildRankCheckResult(input, [
      overview({
        references: [{ domain: "rival.com", url: "https://example.com/page" }],
      }),
    ]);
    expect(result.serpFeatures).toContain("ai_overview_cited");
  });

  it("matches a subdomain of the target", () => {
    const result = buildRankCheckResult(input, [
      overview({ references: [{ domain: "blog.example.com" }] }),
    ]);
    expect(result.serpFeatures).toContain("ai_overview_cited");
  });

  it("does not flag an overview that cites someone else", () => {
    const result = buildRankCheckResult(input, [
      overview({
        references: [{ domain: "rival.com" }, { url: "not a url" }],
      }),
    ]);
    expect(result.serpFeatures).toEqual(["ai_overview"]);
  });

  it("does not add the flag when no overview is present", () => {
    const result = buildRankCheckResult(input, [
      { type: "organic", rank_group: 1, domain: "example.com", url: "https://example.com" },
    ]);
    expect(result.serpFeatures).toEqual(["organic"]);
    expect(result.position).toBe(1);
  });
});

describe("live rank check AI Overview fee", () => {
  it("asks for the async AI Overview on desktop only", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        status_code: 20000,
        tasks: [
          {
            id: "live-1",
            status_code: 20000,
            cost: 0.004,
            path: ["v3", "serp", "google", "organic", "live", "advanced"],
            result: [{ items: [] }],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    for (const device of ["desktop", "mobile"] as const) {
      await fetchRankCheckSerp({
        keyword: "alpha",
        keywordId: "kw-1",
        locationCode: 2840,
        languageCode: "en",
        device,
        targetDomain: "example.com",
        depth: 20,
      });
    }

    expect(
      fetchMock.mock.calls.map((call) => parseDataforseoRequestBody(call[1])),
    ).toMatchObject([
      [{ device: "desktop", load_async_ai_overview: true }],
      [{ device: "mobile", load_async_ai_overview: false }],
    ]);
  });
});
