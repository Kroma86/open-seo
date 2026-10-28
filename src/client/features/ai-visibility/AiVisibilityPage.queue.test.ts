import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AiVisibilityPage } from "./AiVisibilityPage";

const mocks = vi.hoisted(() => ({
  latest: {} as any,
  queries: [] as any[],
  effects: [] as Array<() => void>,
  invalidate: vi.fn(),
}));
vi.mock("react", async () => ({
  ...(await vi.importActual<typeof import("react")>("react")),
  useEffect: (fn: () => void) => {
    mocks.effects.push(fn);
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useQuery: (options: any) => {
    mocks.queries.push(options);
    return options.queryKey[0] === "ai-visibility-configs"
      ? { isSuccess: true, data: [{ id: "config1", brand: "Acme" }] }
      : options.queryKey[0] === "ai-visibility"
        ? { data: mocks.latest }
        : { data: { runs: [], measured: false } };
  },
}));
vi.mock("@/client/features/billing/HostedPlanGate", () => ({
  HostedPlanGate: ({ children }: any) => children({ isFreePlan: false }),
}));
vi.mock("@/serverFunctions/ai-visibility", () => ({
  addAiVisibilityTrackingPrompt: vi.fn(),
  createAiVisibilityTrackingConfig: vi.fn(),
  getAiVisibilityTracking: vi.fn(),
  getAiVisibilityTrackingTrend: vi.fn(),
  listAiVisibilityTrackingConfigs: vi.fn(),
  triggerAiVisibilityCheck: vi.fn(),
}));

beforeEach(() => {
  mocks.effects = [];
  mocks.queries = [];
  mocks.invalidate.mockReset();
  mocks.invalidate.mockResolvedValue(undefined);
  mocks.latest = {
    measured: false,
    source: "dataforseo_llm_mentions",
    config: {
      id: "config1",
      brand: "Acme",
      competitors: [],
      platforms: ["google"],
      scheduleInterval: "manual",
      promptSetVersion: 1,
      prompts: [{ id: "p1", prompt: "test", isActive: true }],
    },
    activeRun: null,
    latestAttempt: null,
    latestRun: null,
  };
});

describe("manual AI queue presentation", () => {
  it.each([
    ["pending", "Check queued"],
    ["running", "Checking…"],
  ])(
    "shows %s and polls stored state without launching work",
    (status, label) => {
      mocks.latest.activeRun = { id: "run1", status };
      const html = renderToStaticMarkup(
        createElement(AiVisibilityPage, { projectId: "project1" }),
      );
      expect(html).toContain(label);
      expect(html).toMatch(
        new RegExp(`<button[^>]*disabled[^>]*>${label}</button>`),
      );
      const query = mocks.queries.find(
        (q) => q.queryKey[0] === "ai-visibility",
      );
      expect(query.refetchInterval({ state: { data: mocks.latest } })).toBe(
        5000,
      );
    },
  );
  it("shows failure separately from completed measurements and stops polling", () => {
    mocks.latest.latestAttempt = {
      id: "run1",
      status: "failed",
      error: "The check did not complete.",
    };
    const html = renderToStaticMarkup(
      createElement(AiVisibilityPage, { projectId: "project1" }),
    );
    expect(html).toContain("The latest check did not finish");
    expect(html).toContain("Run check now");
    expect(
      mocks.queries
        .find((q) => q.queryKey[0] === "ai-visibility")
        .refetchInterval({ state: { data: mocks.latest } }),
    ).toBe(false);
  });
  it("refreshes the trend when a newly completed run is read", () => {
    mocks.latest.latestRun = { id: "done1" };
    renderToStaticMarkup(
      createElement(AiVisibilityPage, { projectId: "project1" }),
    );
    for (const effect of mocks.effects) effect();
    expect(mocks.invalidate).toHaveBeenCalledWith({
      queryKey: ["ai-visibility-trend", "project1", "config1"],
    });
  });
});
