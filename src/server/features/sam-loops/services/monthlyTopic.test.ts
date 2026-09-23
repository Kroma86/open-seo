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
});
