import { SamLoopRepository } from "@/server/features/sam-loops/repositories/SamLoopRepository";
import {
  expectedSamLoopDraftsPerMonth,
  isSamContentLoop,
} from "@/shared/sam-loops";
import type { ContentVelocity } from "@/types/schemas/sam-loops";

function contentVelocityWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const sinceIso = new Date(Date.UTC(year, month - 2, 1)).toISOString();
  const months: string[] = [];
  for (let offset = 2; offset >= 0; offset -= 1) {
    const d = new Date(Date.UTC(year, month - offset, 1));
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    months.push(ym);
  }
  return { sinceIso, months };
}

function emptyMonthCounts(months: string[]) {
  return Object.fromEntries(months.map((month) => [month, 0]));
}

export async function getContentVelocity(
  projectId: string,
): Promise<ContentVelocity> {
  const { sinceIso, months } = contentVelocityWindow();
  const [loops, runs] = await Promise.all([
    SamLoopRepository.getLoopsForProject(projectId),
    SamLoopRepository.getContentVelocityForProject(projectId, sinceIso),
  ]);

  const contentLoops = loops.filter(isSamContentLoop);
  const monthSet = new Set(months);
  const knownCadences = new Set(["monthly", "weekly", "daily"]);

  const byLoopId = new Map(
    contentLoops.map((loop) => {
      if (!knownCadences.has(loop.cadence)) {
        throw new Error("unknown cadence: " + loop.cadence);
      }
      return [
        loop.id,
        {
          loopId: loop.id,
          loopName: loop.name,
          cadence: loop.cadence,
          isEnabled: loop.isEnabled,
          expectedPerMonth: expectedSamLoopDraftsPerMonth(loop.cadence),
          drafted: emptyMonthCounts(months),
          completedWithoutDraft: emptyMonthCounts(months),
        },
      ];
    }),
  );

  for (const run of runs) {
    if (!run.finishedAt) continue;
    const monthKey = run.finishedAt.slice(0, 7);
    if (!monthSet.has(monthKey)) continue;
    const entry = byLoopId.get(run.loopId);
    if (!entry) continue;
    if (run.hasDraft) {
      entry.drafted[monthKey] += 1;
    } else {
      entry.completedWithoutDraft[monthKey] += 1;
    }
  }

  return {
    months,
    loops: [...byLoopId.values()],
  };
}
