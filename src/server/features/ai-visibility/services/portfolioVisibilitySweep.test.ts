import { describe, expect, it, vi } from "vitest";
import {
  buildPortfolioVisibilityRow,
  buildPortfolioVisibilitySnapshot,
  classifyFreshness,
  namedInRate,
  PortfolioVisibilitySweepError,
  selectConfig,
  type PortfolioSweepProject,
  type PortfolioTrackingConfig,
  type PortfolioVisibilitySource,
} from "./portfolioVisibilitySweep";
import type { AiVisibilityLatestResults } from "@/types/schemas/ai-visibility";

const NOW = new Date("2026-09-10T00:00:00.000Z");
const GENERATED_AT = NOW.toISOString();

function project(
  id: string,
  overrides: Partial<PortfolioSweepProject> = {},
): PortfolioSweepProject {
  return {
    id,
    name: `Client ${id}`,
    domain: `${id}.example.test`,
    repairLoopEnabled: true,
    ...overrides,
  };
}

function config(
  id: string,
  overrides: Partial<PortfolioTrackingConfig> = {},
): PortfolioTrackingConfig {
  return {
    id,
    brand: `Brand ${id}`,
    isActive: true,
    scheduleInterval: "weekly",
    promptSetVersion: 3,
    createdAt: "2026-08-01T00:00:00.000Z",
    prompts: [
      { id: "p1", isActive: true },
      { id: "p2", isActive: true },
      { id: "p3", isActive: false },
    ],
    ...overrides,
  };
}

function latest(
  overrides: Partial<AiVisibilityLatestResults> = {},
): AiVisibilityLatestResults {
  return {
    measured: true,
    source: "dataforseo_llm_mentions",
    fetchedAt: "2026-09-08T12:00:00.000Z",
    config: {
      id: "cfg_1",
      brand: "Brand cfg_1",
      competitors: [],
      platforms: ["chat_gpt", "google"],
      scheduleInterval: "weekly",
      promptSetVersion: 3,
      prompts: [],
    },
    latestRun: {
      id: "run_1",
      status: "completed",
      finishedAt: "2026-09-08T12:00:00.000Z",
      totalMentions: 37,
      partialMentions: false,
      shareOfVoicePct: 12.5,
      promptsWithBrand: 2,
      promptsChecked: 5,
      promptSetVersion: 3,
      costNote: null,
      error: null,
    },
    ...overrides,
  };
}

function source(overrides: Partial<PortfolioVisibilitySource> = {}) {
  return {
    listProjects: vi.fn().mockResolvedValue([]),
    listTrackingConfigs: vi.fn().mockResolvedValue([]),
    getAiVisibilityTrend: vi.fn().mockResolvedValue(latest()),
    ...overrides,
  } satisfies PortfolioVisibilitySource;
}

describe("namedInRate", () => {
  it("computes a 0–1 rate at 4 decimal places", () => {
    expect(namedInRate(2, 5)).toBe(0.4);
    expect(namedInRate(1, 3)).toBe(0.3333);
  });

  it("keeps a measured zero as zero", () => {
    expect(namedInRate(0, 4)).toBe(0);
  });

  it("is null when the run checked zero prompts or counts are missing", () => {
    expect(namedInRate(0, 0)).toBeNull();
    expect(namedInRate(null, 5)).toBeNull();
    expect(namedInRate(2, null)).toBeNull();
  });
});

describe("classifyFreshness", () => {
  it("classifies within grace as fresh and beyond as stale", () => {
    expect(
      classifyFreshness({
        scheduleInterval: "weekly",
        latestCompletedAt: "2026-09-08T00:00:00.000Z",
        now: NOW,
      }),
    ).toBe("fresh");
    expect(
      classifyFreshness({
        scheduleInterval: "weekly",
        latestCompletedAt: "2026-08-20T00:00:00.000Z",
        now: NOW,
      }),
    ).toBe("stale");
  });

  it("treats manual configs as unscheduled and missing runs as null", () => {
    expect(
      classifyFreshness({
        scheduleInterval: "manual",
        latestCompletedAt: "2026-01-01T00:00:00.000Z",
        now: NOW,
      }),
    ).toBe("unscheduled");
    expect(
      classifyFreshness({
        scheduleInterval: "weekly",
        latestCompletedAt: null,
        now: NOW,
      }),
    ).toBeNull();
  });
});

describe("selectConfig", () => {
  it("prefers the active config, then oldest created, then id", () => {
    const inactive = config("cfg_inactive", {
      isActive: false,
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    const activeNewer = config("cfg_b", {
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    const activeOlder = config("cfg_a", {
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    expect(selectConfig([inactive, activeNewer, activeOlder])?.id).toBe(
      "cfg_a",
    );
    expect(selectConfig([inactive])?.id).toBe("cfg_inactive");
    expect(selectConfig([])).toBeNull();
  });
});

describe("buildPortfolioVisibilityRow", () => {
  it("builds an ok row: rate separate from raw mentions, SoV passed through", () => {
    const row = buildPortfolioVisibilityRow({
      project: project("proj_1"),
      config: config("cfg_1"),
      latest: latest(),
      now: NOW,
      generatedAt: GENERATED_AT,
    });
    expect(row).toEqual({
      domain: "proj_1.example.test",
      projectId: "proj_1",
      projectName: "Client proj_1",
      configId: "cfg_1",
      brand: "Brand cfg_1",
      promptSetVersion: 3,
      activePromptCount: 2,
      latestRunId: "run_1",
      latestCompletedAt: "2026-09-08T12:00:00.000Z",
      latestRunStatus: "completed",
      latestRunPromptSetVersion: 3,
      promptSetChanged: false,
      promptsWithBrand: 2,
      promptsChecked: 5,
      namedInRate: 0.4,
      totalMentions: 37,
      shareOfVoicePct: 12.5,
      repairLoopEnabled: true,
      status: "ok",
      freshness: "fresh",
      error: null,
      generatedAt: GENERATED_AT,
    });
    // 37 mentions is not a rate; 0.4 is not a count.
    expect(row.namedInRate).not.toBe(row.totalMentions);
  });

  it("keeps shareOfVoicePct null as not-measured, never zero-filled", () => {
    const row = buildPortfolioVisibilityRow({
      project: project("proj_1"),
      config: config("cfg_1"),
      latest: latest({
        latestRun: { ...latest().latestRun!, shareOfVoicePct: null },
      }),
      now: NOW,
      generatedAt: GENERATED_AT,
    });
    expect(row.shareOfVoicePct).toBeNull();
    expect(row.status).toBe("ok");
  });

  it("keeps a measured zero share-of-voice as zero", () => {
    const row = buildPortfolioVisibilityRow({
      project: project("proj_1"),
      config: config("cfg_1"),
      latest: latest({
        latestRun: {
          ...latest().latestRun!,
          shareOfVoicePct: 0,
          promptsWithBrand: 0,
          promptsChecked: 4,
        },
      }),
      now: NOW,
      generatedAt: GENERATED_AT,
    });
    expect(row.shareOfVoicePct).toBe(0);
    expect(row.namedInRate).toBe(0);
  });

  it("classifies a zero-checked-prompts run as an empty pass, not a baseline", () => {
    const row = buildPortfolioVisibilityRow({
      project: project("proj_1"),
      config: config("cfg_1"),
      latest: latest({
        latestRun: {
          ...latest().latestRun!,
          promptsWithBrand: 0,
          promptsChecked: 0,
        },
      }),
      now: NOW,
      generatedAt: GENERATED_AT,
    });
    expect(row.status).toBe("empty_pass");
    expect(row.namedInRate).toBeNull();
  });

  it("flags a prompt-set version change as a comparison reset", () => {
    const row = buildPortfolioVisibilityRow({
      project: project("proj_1"),
      config: config("cfg_1", { promptSetVersion: 4 }),
      latest: latest({
        config: { ...latest().config!, promptSetVersion: 4 },
        latestRun: { ...latest().latestRun!, promptSetVersion: 3 },
      }),
      now: NOW,
      generatedAt: GENERATED_AT,
    });
    expect(row.promptSetVersion).toBe(4);
    expect(row.latestRunPromptSetVersion).toBe(3);
    expect(row.promptSetChanged).toBe(true);
  });

  it("reports never_measured when no completed run exists", () => {
    const row = buildPortfolioVisibilityRow({
      project: project("proj_1"),
      config: config("cfg_1"),
      latest: {
        measured: false,
        source: "dataforseo_llm_mentions",
        fetchedAt: null,
        config: latest().config,
        latestRun: null,
      },
      now: NOW,
      generatedAt: GENERATED_AT,
    });
    expect(row.status).toBe("never_measured");
    expect(row.latestRunId).toBeNull();
    expect(row.freshness).toBeNull();
    expect(row.namedInRate).toBeNull();
  });

  it("keeps repairLoopEnabled null when the source does not expose it", () => {
    const row = buildPortfolioVisibilityRow({
      project: project("proj_1", { repairLoopEnabled: undefined }),
      config: config("cfg_1"),
      latest: latest(),
      now: NOW,
      generatedAt: GENERATED_AT,
    });
    expect(row.repairLoopEnabled).toBeNull();
  });
});

describe("buildPortfolioVisibilitySnapshot", () => {
  it("marks projects without a config without ever reading the trend", async () => {
    const src = source({
      listProjects: vi.fn().mockResolvedValue([project("proj_1")]),
      listTrackingConfigs: vi.fn().mockResolvedValue([]),
    });
    const snapshot = await buildPortfolioVisibilitySnapshot(src, { now: NOW });
    expect(snapshot.rows[0]?.status).toBe("no_config");
    expect(snapshot.rows[0]?.error?.code).toBe("NO_TRACKING_CONFIG");
    expect(src.getAiVisibilityTrend).not.toHaveBeenCalled();
  });

  it("degrades a failed config read to an unreadable row and continues", async () => {
    const src = source({
      listProjects: vi
        .fn()
        .mockResolvedValue([project("proj_bad"), project("proj_good")]),
      listTrackingConfigs: vi
        .fn()
        .mockRejectedValueOnce(new Error("db timeout"))
        .mockResolvedValueOnce([config("cfg_1")]),
    });
    const snapshot = await buildPortfolioVisibilitySnapshot(src, { now: NOW });
    expect(snapshot.rowCount).toBe(2);
    expect(snapshot.rows[0]?.status).toBe("unreadable");
    expect(snapshot.rows[0]?.error?.code).toBe("CONFIGS_READ_FAILED");
    expect(snapshot.rows[0]?.error?.message).toContain("db timeout");
    expect(snapshot.rows[1]?.status).toBe("ok");
  });

  it("degrades a failed trend read to an unreadable row with config context kept", async () => {
    const src = source({
      listProjects: vi.fn().mockResolvedValue([project("proj_1")]),
      listTrackingConfigs: vi.fn().mockResolvedValue([config("cfg_1")]),
      getAiVisibilityTrend: vi.fn().mockRejectedValue(new Error("read failed")),
    });
    const snapshot = await buildPortfolioVisibilitySnapshot(src, { now: NOW });
    const row = snapshot.rows[0];
    expect(row?.status).toBe("unreadable");
    expect(row?.error?.code).toBe("TREND_READ_FAILED");
    expect(row?.configId).toBe("cfg_1");
    expect(row?.promptSetVersion).toBe(3);
  });

  it("throws a typed error when the project list itself fails", async () => {
    const src = source({
      listProjects: vi.fn().mockRejectedValue(new Error("org read down")),
    });
    try {
      await buildPortfolioVisibilitySnapshot(src, { now: NOW });
      expect.unreachable("snapshot should throw when listProjects fails");
    } catch (error) {
      expect(error).toBeInstanceOf(PortfolioVisibilitySweepError);
      if (error instanceof PortfolioVisibilitySweepError) {
        expect(error.code).toBe("PROJECTS_READ_FAILED");
        expect(error.message).toContain("org read down");
      }
    }
  });

  it("sweeps a 38-project portfolio into 38 rows with one generatedAt", async () => {
    const projects = Array.from({ length: 38 }, (_, index) =>
      project(`proj_${String(index + 1).padStart(2, "0")}`),
    );
    const src = source({
      listProjects: vi.fn().mockResolvedValue(projects),
      listTrackingConfigs: vi
        .fn()
        .mockImplementation((projectId: string) =>
          Promise.resolve(
            projectId === "proj_07" ? [] : [config(`cfg_${projectId}`)],
          ),
        ),
      getAiVisibilityTrend: vi
        .fn()
        .mockImplementation((projectId: string, configId: string) =>
          Promise.resolve(
            latest({
              config: { ...latest().config!, id: configId },
              latestRun: { ...latest().latestRun!, id: `run_${projectId}` },
            }),
          ),
        ),
    });
    const snapshot = await buildPortfolioVisibilitySnapshot(src, { now: NOW });
    expect(snapshot.rowCount).toBe(38);
    expect(snapshot.generatedAt).toBe(GENERATED_AT);
    expect(new Set(snapshot.rows.map((row) => row.generatedAt))).toEqual(
      new Set([GENERATED_AT]),
    );
    expect(snapshot.rows.map((row) => row.projectId)).toEqual(
      projects.map((p) => p.id),
    );
    expect(
      snapshot.rows.filter((row) => row.status === "ok"),
    ).toHaveLength(37);
    expect(
      snapshot.rows.find((row) => row.projectId === "proj_07")?.status,
    ).toBe("no_config");
    // One trend read per configured project; none for the config-less one.
    expect(src.getAiVisibilityTrend).toHaveBeenCalledTimes(37);
  });
});
