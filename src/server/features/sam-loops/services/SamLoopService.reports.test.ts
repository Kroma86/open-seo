import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { article, saved, source } from "./monthlyContent.fixture";
import {
  hasVerifiedMonthlyDraft,
  stripDraftEvidence,
  validateMonthlyContent,
} from "./monthlyContentResult";

const mocks = vi.hoisted(() => ({
  getLoopsForProject: vi.fn(),
  getRecentRunsForProject: vi.fn(),
  getRunsForLoop: vi.fn(),
  getRunById: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: { SAM_LOOP_WORKFLOW: {} } }));
vi.mock("@/server/features/sam-loops/repositories/SamLoopRepository", () => ({
  SamLoopRepository: mocks,
}));

import {
  getSamLoopRun,
  getSamLoopRuns,
  listSamLoopsForProject,
} from "./SamLoopService";

let stored: Readonly<{ id: string; projectId: string; report: string }>;

beforeAll(async () => {
  const checked = await validateMonthlyContent(
    article,
    [{ toolResults: [saved, source] }],
    "example.com",
  );
  expect(checked.error).toBeNull();
  stored = Object.freeze({
    id: "run_article",
    projectId: "project_example",
    report: checked.report,
  });
});

beforeEach(() => {
  mocks.getLoopsForProject.mockResolvedValue([]);
  mocks.getRecentRunsForProject.mockResolvedValue([stored]);
  mocks.getRunsForLoop.mockResolvedValue([stored]);
  mocks.getRunById.mockResolvedValue(stored);
});

describe("public loop report reads", () => {
  it.each([
    {
      name: "project loop overview",
      read: async () =>
        (await listSamLoopsForProject("project_example")).runs[0],
    },
    {
      name: "project run history",
      read: async () =>
        (await getSamLoopRuns({ projectId: "project_example" }))[0],
    },
    {
      name: "one loop's run history",
      read: async () =>
        (
          await getSamLoopRuns({
            projectId: "project_example",
            loopId: "loop_article",
          })
        )[0],
    },
    {
      name: "single run detail",
      read: () =>
        getSamLoopRun({
          projectId: "project_example",
          runId: "run_article",
        }),
    },
  ])(
    "$name returns article prose and preserves internal evidence",
    async ({ read }) => {
      const result = await read();
      expect(result).toEqual({
        ...stored,
        report: stripDraftEvidence(stored.report),
      });
      expect(result?.report).toContain(article.body.trim());
      expect(result?.report).not.toContain("openseo-monthly-draft");
      await expect(hasVerifiedMonthlyDraft(stored.report)).resolves.toBe(true);
    },
  );
});
