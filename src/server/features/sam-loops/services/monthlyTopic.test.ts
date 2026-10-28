import { describe, expect, it, vi } from "vitest";
import { selectMonthlyTopic } from "./monthlyTopic";
import { z } from "zod";

function readers() {
  return {
    list_saved_keywords: {
      inputSchema: z.object({}),
      execute: vi.fn().mockResolvedValue({ data: { rows: [] } }),
    },
    get_rank_tracker: {
      inputSchema: z.object({}),
      execute: vi.fn().mockResolvedValue({ data: { configs: [] } }),
    },
    get_search_console_performance: {
      inputSchema: z.object({}),
      execute: vi
        .fn()
        .mockResolvedValue({ data: { ok: false, reason: "not_connected" } }),
    },
  };
}
describe("monthly topic admission", () => {
  it("rotates away from a previously verified target", async () => {
    const tools = readers();
    tools.list_saved_keywords.execute.mockResolvedValue({
      data: {
        rows: [{ keyword: "drain cleaning" }, { keyword: "drain inspection" }],
      },
    });
    expect(
      await selectMonthlyTopic(tools, new Set(["drain cleaning"])),
    ).toMatchObject({ status: "ready", keyword: "drain inspection" });
  });
  it("reports exhausted topics separately from no data", async () => {
    const tools = readers();
    tools.list_saved_keywords.execute.mockResolvedValue({
      data: { rows: [{ keyword: "drain cleaning" }] },
    });
    expect(
      await selectMonthlyTopic(tools, new Set(["drain cleaning"])),
    ).toMatchObject({ status: "no_new_topic", candidateCount: 1 });
  });
  it("does not claim exhaustion when saved keywords were truncated", async () => {
    const tools = readers();
    tools.list_saved_keywords.execute.mockResolvedValue({
      data: { rows: [{ keyword: "drain cleaning" }], totalCount: 2 },
    });
    expect(
      await selectMonthlyTopic(tools, new Set(["drain cleaning"])),
    ).toMatchObject({ status: "unavailable" });
  });
  it("does not call an unknown feed state empty", async () => {
    const tools = readers();
    tools.get_rank_tracker.execute.mockResolvedValue({
      data: {
        configs: [],
        externalObservations: { status: "error", rows: [] },
      },
    });
    expect(await selectMonthlyTopic(tools)).toMatchObject({
      status: "unavailable",
    });
  });
  it("uses validated imported terms returned by the project tracker list", async () => {
    const tools = readers();
    tools.get_rank_tracker.execute.mockResolvedValue({
      data: {
        configs: [],
        externalObservations: {
          status: "available",
          rows: [{ keyword: "drain cleaning" }],
        },
      },
    });
    expect(await selectMonthlyTopic(tools)).toMatchObject({
      status: "ready",
      keyword: "drain cleaning",
    });
  });
  it("does not call an invalid imported feed empty", async () => {
    const tools = readers();
    tools.get_rank_tracker.execute.mockResolvedValue({
      data: {
        configs: [],
        externalObservations: { status: "invalid", rows: [] },
      },
    });
    expect(await selectMonthlyTopic(tools)).toMatchObject({
      status: "unavailable",
    });
  });
  it("finds tracker IDs before selecting an exact tracked term", async () => {
    const tools = readers();
    tools.get_rank_tracker.execute
      .mockResolvedValueOnce({ data: { configs: [{ id: "tracker-1" }] } })
      .mockResolvedValueOnce({
        data: { results: { rows: [{ keyword: " Drain cleaning " }] } },
      });
    expect(await selectMonthlyTopic(tools)).toMatchObject({
      status: "ready",
      keyword: "Drain cleaning",
    });
    expect(tools.get_rank_tracker.execute).toHaveBeenNthCalledWith(
      2,
      { trackerId: "tracker-1" },
      expect.anything(),
    );
    expect(tools.get_search_console_performance.execute).not.toHaveBeenCalled();
  });
  it("selects measured GSC queries after empty saved and tracked terms", async () => {
    const tools = readers();
    tools.get_search_console_performance.execute.mockResolvedValue({
      data: {
        ok: true,
        dimensions: ["query"],
        rows: [{ keys: ["drain cleaning"] }],
      },
    });
    expect(await selectMonthlyTopic(tools)).toMatchObject({
      status: "ready",
      keyword: "drain cleaning",
    });
  });
  it.each([
    { error: "unavailable", data: { rows: [] } },
    { data: { error: "unavailable", rows: [] } },
    { data: {} },
  ])(
    "does not disguise failed or malformed reads as no data",
    async (output) => {
      const tools = readers();
      tools.list_saved_keywords.execute.mockResolvedValue(output);
      expect(await selectMonthlyTopic(tools)).toMatchObject({
        status: "unavailable",
      });
    },
  );
  it("does not treat a failed GSC query as disconnected", async () => {
    const tools = readers();
    tools.get_search_console_performance.execute.mockResolvedValue({
      data: { ok: false, reason: "api_error" },
    });
    expect(await selectMonthlyTopic(tools)).toMatchObject({
      status: "unavailable",
    });
  });
  it.each([
    { ok: false, rows: [] },
    { ok: false, rows: [{ keyword: "drain cleaning" }] },
    { rows: [{ keyword: 42 }] },
    { rows: [null] },
    { rows: [{ keyword: "drain cleaning" }, null] },
    { rows: [{ keyword: "" }] },
    { rows: [{ keyword: "   " }] },
    { rows: ["drain cleaning"] },
    { rows: [], totalCount: 1.5 },
  ])(
    "does not treat an explicit or malformed saved-keyword read as empty or exhausted: %j",
    async (data) => {
      const tools = readers();
      tools.list_saved_keywords.execute.mockResolvedValue({ data });
      expect(await selectMonthlyTopic(tools)).toMatchObject({
        status: "unavailable",
      });
      expect(
        await selectMonthlyTopic(tools, new Set(["drain cleaning"])),
      ).toMatchObject({ status: "unavailable" });
    },
  );
  it("treats empty saved, tracked, and disconnected search console reads as no data", async () => {
    expect(await selectMonthlyTopic(readers())).toMatchObject({
      status: "no_data",
    });
  });
  it.each(["not_connected", "gsc_oauth_not_configured"])(
    "treats %s search console as no data when no other topic exists",
    async (reason) => {
      const tools = readers();
      tools.get_search_console_performance.execute.mockResolvedValue({
        data: { ok: false, reason },
      });
      expect(await selectMonthlyTopic(tools)).toMatchObject({
        status: "no_data",
      });
    },
  );
  it("treats a successful empty search console query as no data", async () => {
    const tools = readers();
    tools.get_search_console_performance.execute.mockResolvedValue({
      data: { ok: true, dimensions: ["query"], rows: [], hasMore: false },
    });
    expect(await selectMonthlyTopic(tools)).toMatchObject({
      status: "no_data",
    });
  });
  it("treats a missing imported feed and an empty tracked result as no data", async () => {
    const tools = readers();
    tools.get_rank_tracker.execute
      .mockResolvedValueOnce({
        data: { configs: [{ id: "tracker-1" }], externalObservations: { status: "missing" } },
      })
      .mockResolvedValueOnce({ data: { results: { rows: [] } } });
    expect(await selectMonthlyTopic(tools)).toMatchObject({
      status: "no_data",
    });
  });
  it("treats an available import feed with no rows as no data", async () => {
    const tools = readers();
    tools.get_rank_tracker.execute.mockResolvedValue({
      data: {
        configs: [],
        externalObservations: { status: "available", rows: [] },
      },
    });
    expect(await selectMonthlyTopic(tools)).toMatchObject({
      status: "no_data",
    });
  });
  it("uses a valid imported term when saved keywords explicitly fail", async () => {
    const tools = readers();
    tools.list_saved_keywords.execute.mockResolvedValue({
      data: { ok: false, rows: [{ keyword: "should not use" }] },
    });
    tools.get_rank_tracker.execute.mockResolvedValue({
      data: {
        configs: [],
        externalObservations: {
          status: "available",
          rows: [{ keyword: "drain inspection" }],
        },
      },
    });
    expect(await selectMonthlyTopic(tools)).toMatchObject({
      status: "ready",
      keyword: "drain inspection",
    });
  });
  it("uses a later valid tracker when an earlier detail is malformed", async () => {
    const tools = readers();
    tools.get_rank_tracker.execute
      .mockResolvedValueOnce({
        data: { configs: [{ id: "tracker-1" }, { id: "tracker-2" }] },
      })
      .mockResolvedValueOnce({ data: { results: { rows: [null] } } })
      .mockResolvedValueOnce({
        data: { results: { rows: [{ keyword: "drain inspection" }] } },
      });
    expect(await selectMonthlyTopic(tools)).toMatchObject({
      status: "ready",
      keyword: "drain inspection",
    });
    expect(tools.get_search_console_performance.execute).not.toHaveBeenCalled();
  });
  it("uses search console when saved and tracked rows are malformed", async () => {
    const tools = readers();
    tools.list_saved_keywords.execute.mockResolvedValue({
      data: { rows: [{ keyword: "should not use" }, null] },
    });
    tools.get_rank_tracker.execute
      .mockResolvedValueOnce({ data: { configs: [{ id: "tracker-1" }] } })
      .mockResolvedValueOnce({ data: { results: { rows: [{ keyword: 42 }] } } });
    tools.get_search_console_performance.execute.mockResolvedValue({
      data: {
        ok: true,
        dimensions: ["page", "query"],
        rows: [
          {
            keys: ["https://example.com/services/drains", "drain cleaning"],
          },
        ],
      },
    });
    expect(await selectMonthlyTopic(tools)).toMatchObject({
      status: "ready",
      keyword: "drain cleaning",
    });
  });
  it("does not select imported terms from a malformed available feed", async () => {
    const tools = readers();
    tools.get_rank_tracker.execute.mockResolvedValue({
      data: {
        configs: [],
        externalObservations: {
          status: "available",
          rows: [{ keyword: "drain cleaning" }, { keyword: 7 }],
        },
      },
    });
    expect(await selectMonthlyTopic(tools)).toMatchObject({
      status: "unavailable",
    });
    expect(
      await selectMonthlyTopic(tools, new Set(["drain cleaning"])),
    ).toMatchObject({ status: "unavailable" });
  });
  it("does not treat a missing available import list as empty", async () => {
    const tools = readers();
    tools.get_rank_tracker.execute.mockResolvedValue({
      data: { configs: [], externalObservations: { status: "available" } },
    });
    expect(await selectMonthlyTopic(tools)).toMatchObject({
      status: "unavailable",
    });
  });
  it("does not select a tracked term from an explicit failed detail read", async () => {
    for (const usedTopics of [new Set<string>(), new Set(["drain cleaning"])]) {
      const tools = readers();
      tools.get_rank_tracker.execute
        .mockResolvedValueOnce({ data: { configs: [{ id: "tracker-1" }] } })
        .mockResolvedValueOnce({
          data: {
            ok: false,
            results: { rows: [{ keyword: "drain cleaning" }] },
          },
        });
      expect(await selectMonthlyTopic(tools, usedTopics)).toMatchObject({
        status: "unavailable",
      });
    }
  });
  it("does not treat an explicit tracker failure as empty", async () => {
    const tools = readers();
    tools.get_rank_tracker.execute.mockResolvedValue({
      data: {
        ok: false,
        configs: [],
        externalObservations: {
          status: "available",
          rows: [{ keyword: "drain cleaning" }],
        },
      },
    });
    expect(await selectMonthlyTopic(tools)).toMatchObject({
      status: "unavailable",
    });
  });
  it.each([
    { ok: true, dimensions: ["query"], rows: [{ keys: [42] }] },
    { ok: true, dimensions: ["query"], rows: [null] },
    { ok: true, dimensions: ["query"], rows: [{ keys: [""] }] },
    { ok: true, dimensions: ["query"], rows: [{ keys: ["   "] }] },
    {
      ok: true,
      dimensions: ["query"],
      rows: [{ keys: ["drain cleaning"] }, { keys: [7] }],
    },
    { ok: true, dimensions: ["page"], rows: [{ keys: ["drain cleaning"] }] },
    {
      ok: true,
      dimensions: ["page", "query"],
      rows: [{ keys: ["https://example.com/services/drains", ""] }],
    },
  ])(
    "does not treat a malformed search console read as empty or exhausted: %j",
    async (data) => {
      const tools = readers();
      tools.get_search_console_performance.execute.mockResolvedValue({ data });
      expect(await selectMonthlyTopic(tools)).toMatchObject({
        status: "unavailable",
      });
      expect(
        await selectMonthlyTopic(tools, new Set(["drain cleaning"])),
      ).toMatchObject({ status: "unavailable" });
    },
  );
  it("preserves measured query spelling from a clean search console row", async () => {
    const tools = readers();
    tools.get_search_console_performance.execute.mockResolvedValue({
      data: {
        ok: true,
        dimensions: ["query"],
        rows: [{ keys: [" Drain cleaning "] }],
      },
    });
    expect(await selectMonthlyTopic(tools)).toMatchObject({
      status: "ready",
      keyword: "Drain cleaning",
    });
  });
});
