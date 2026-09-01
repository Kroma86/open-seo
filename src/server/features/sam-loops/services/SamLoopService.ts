import { env } from "cloudflare:workers";
import { AppError } from "@/server/lib/errors";
import { SamLoopRepository } from "@/server/features/sam-loops/repositories/SamLoopRepository";
import { beginSamLoopRun } from "@/server/features/sam-loops/services/samLoopRunGuards";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { getAgencyScoreInputsGlobal } from "@/server/features/agency/AgencyScoreInputsService";
import { buildSamSkillSource } from "@/server/features/sam/samSkills";
import {
  computeNextSamLoopRunAt,
  expectedSamLoopDraftsPerMonth,
  isSamContentLoop,
} from "@/shared/sam-loops";
import type { ContentVelocity } from "@/types/schemas/sam-loops";
import type {
  SamLoopTriggerResult,
  createSamLoopSchema,
  updateSamLoopSchema,
} from "@/types/schemas/sam-loops";
import type { z } from "zod";

/** Pure list — defaults are seeded on project create, not on every read. */
export async function listSamLoopsForProject(projectId: string) {
  const loops = await SamLoopRepository.getLoopsForProject(projectId);
  const runs = await SamLoopRepository.getRecentRunsForProject({
    projectId,
    limit: 40,
  });
  return { loops, runs };
}

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

  const byLoopId = new Map(
    contentLoops.map((loop) => [
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
    ]),
  );

  for (const run of runs) {
    const monthKey = run.finishedAt.slice(0, 7);
    if (!monthSet.has(monthKey)) continue;
    const entry = byLoopId.get(run.loopId);
    if (!entry) continue;
    if (run.hasReport) {
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

export async function listAvailableSamLoopSkills() {
  const skills = await buildSamSkillSource().list();
  return skills;
}

export async function createSamLoop(
  input: z.infer<typeof createSamLoopSchema>,
) {
  if (input.sourceType === "skill" && input.skillName) {
    const skill = await buildSamSkillSource().load(input.skillName);
    if (!skill) {
      throw new AppError("VALIDATION_ERROR", `Unknown skill: ${input.skillName}`);
    }
  }

  return SamLoopRepository.createLoop({
    id: crypto.randomUUID(),
    projectId: input.projectId,
    name: input.name,
    sourceType: input.sourceType,
    skillName: input.sourceType === "skill" ? (input.skillName ?? null) : null,
    customPrompt:
      input.sourceType === "custom" ? (input.customPrompt ?? null) : null,
    cadence: input.cadence,
    isEnabled: input.isEnabled ?? true,
    nextRunAt: computeNextSamLoopRunAt(input.cadence),
  });
}

export async function updateSamLoop(
  input: z.infer<typeof updateSamLoopSchema>,
) {
  const existing = await SamLoopRepository.getLoopById(
    input.loopId,
    input.projectId,
  );
  if (!existing) {
    throw new AppError("NOT_FOUND", "Loop not found");
  }

  const cadence = input.cadence ?? existing.cadence;
  const patch: Parameters<typeof SamLoopRepository.updateLoop>[2] = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
    ...(input.customPrompt !== undefined
      ? { customPrompt: input.customPrompt }
      : {}),
  };

  if (input.cadence !== undefined && input.cadence !== existing.cadence) {
    patch.cadence = input.cadence;
    // Re-anchor schedule when cadence changes.
    patch.nextRunAt = computeNextSamLoopRunAt(cadence);
  }

  // Enabling a loop that has no nextRunAt (or was never scheduled) schedules it.
  if (input.isEnabled === true && !existing.nextRunAt) {
    patch.nextRunAt = computeNextSamLoopRunAt(cadence);
  }

  const updated = await SamLoopRepository.updateLoop(
    input.loopId,
    input.projectId,
    patch,
  );
  if (!updated) {
    throw new AppError("NOT_FOUND", "Loop not found");
  }
  return updated;
}

export async function getSamLoopRuns(input: {
  projectId: string;
  loopId?: string;
  limit?: number;
}) {
  if (input.loopId) {
    return SamLoopRepository.getRunsForLoop({
      loopId: input.loopId,
      projectId: input.projectId,
      limit: input.limit,
    });
  }
  return SamLoopRepository.getRecentRunsForProject({
    projectId: input.projectId,
    limit: input.limit,
  });
}

export async function getSamLoopRun(input: {
  projectId: string;
  runId: string;
}) {
  const run = await SamLoopRepository.getRunById(input.runId);
  if (!run || run.projectId !== input.projectId) {
    throw new AppError("NOT_FOUND", "Run not found");
  }
  return run;
}

export async function triggerSamLoop(input: {
  projectId: string;
  loopId: string;
  organizationId: string;
}): Promise<SamLoopTriggerResult> {
  const loop = await SamLoopRepository.getLoopById(
    input.loopId,
    input.projectId,
  );
  if (!loop) {
    return { ok: false, reason: "not_found" };
  }
  if (!loop.isEnabled) {
    return { ok: false, reason: "disabled" };
  }

  // Manual trigger schedule rule:
  // - nextRunAt in the future → leave it alone (manual run is extra; scheduled
  //   run still happens).
  // - nextRunAt missing or due/overdue → set to computeNextSamLoopRunAt(cadence)
  //   anchored on now so due loops don't pile up.
  // lastRunAt is written when the run completes (workflow), not here.
  // claimDueLoop is deliberately best-effort: a lost CAS (concurrent cron)
  // means someone else already advanced the schedule; single-in-flight is
  // still DB-enforced when we start the run below.
  const nextRunMs = loop.nextRunAt
    ? new Date(loop.nextRunAt).getTime()
    : Number.NaN;
  const nextRunIsFuture =
    Number.isFinite(nextRunMs) && nextRunMs > Date.now();

  if (!nextRunIsFuture) {
    // CAS only when we have a parsable observed nextRunAt. A corrupt value
    // would never match claimDueLoop's equality check and would leave the
    // loop unscheduled forever — fall through to re-anchor from now instead.
    if (loop.nextRunAt && Number.isFinite(nextRunMs)) {
      const claimed = await SamLoopRepository.claimDueLoop({
        loopId: loop.id,
        projectId: loop.projectId,
        observedNextRunAt: loop.nextRunAt,
        nextRunAt: computeNextSamLoopRunAt(loop.cadence),
      });
      if (!claimed) {
        console.log(
          `[sam-loop] manual trigger claim lost (best-effort) loop=${loop.id} project=${loop.projectId}`,
        );
      }
    } else {
      await SamLoopRepository.updateLoop(loop.id, loop.projectId, {
        nextRunAt: computeNextSamLoopRunAt(loop.cadence),
      });
    }
  }

  return beginSamLoopRun({
    workflow: env.SAM_LOOP_WORKFLOW,
    loopId: loop.id,
    projectId: input.projectId,
    organizationId: input.organizationId,
    trigger: "manual",
    workflowStartErrorMessage: "Failed to start Sam loop",
  });
}

export async function seedDefaultSamLoopsForProject(projectId: string) {
  return SamLoopRepository.ensureDefaultLoops(projectId);
}

/** Resolve org id for a project (manual trigger / billing context). */
export async function getOrganizationIdForProject(projectId: string) {
  const project = await ProjectRepository.getProjectById(projectId);
  return project?.organizationId ?? null;
}

export type DomainLoopTriggerRow = {
  loopId: string;
  loopName: string;
  skillName: string | null;
  result: SamLoopTriggerResult;
};

export type DomainLoopTriggerResult =
  | { ok: false; reason: "project_not_found" | "domain_not_allowed" }
  | {
      ok: true;
      projectId: string;
      projectName: string;
      domain: string | null;
      seeded: number;
      capped: boolean;
      results: DomainLoopTriggerRow[];
    };

/** Internal soak trigger is dogfood-only. Skills already refuse other domains. */
const DOGFOOD_TRIGGER_DOMAIN = "niceseo.ai";
const DOGFOOD_TRIGGER_CAP = 8;

function normalizeTriggerDomain(raw: string): string {
  let host = raw.trim().toLowerCase();
  for (const prefix of ["https://", "http://"]) {
    if (host.startsWith(prefix)) host = host.slice(prefix.length);
  }
  if (host.startsWith("www.")) host = host.slice(4);
  return host.split("/")[0] ?? host;
}

/**
 * Seed missing defaults, then start a manual run for each matching enabled
 * loop on the project that owns `domain`. Used by the Hermes/internal soak
 * path so we can fire niceseo.ai loops without Cloudflare Access.
 */
export async function triggerSamLoopsForDomain(input: {
  domain: string;
  names?: string[];
}): Promise<DomainLoopTriggerResult> {
  const domain = normalizeTriggerDomain(input.domain);
  if (domain !== DOGFOOD_TRIGGER_DOMAIN) {
    return { ok: false, reason: "domain_not_allowed" };
  }
  const score = await getAgencyScoreInputsGlobal(domain);
  if (!score.projectId) {
    return { ok: false, reason: "project_not_found" };
  }
  const project = await ProjectRepository.getProjectById(score.projectId);
  if (!project) {
    return { ok: false, reason: "project_not_found" };
  }

  const seeded = await SamLoopRepository.ensureDefaultLoops(project.id);
  const loops = await SamLoopRepository.getLoopsForProject(project.id);
  const want = (input.names ?? [])
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);

  const selected = loops.filter((loop) => {
    if (!loop.isEnabled) return false;
    if (want.length === 0) return true;
    const skill = loop.skillName?.toLowerCase() ?? "";
    const name = loop.name.toLowerCase();
    return want.some((needle) => needle === skill || needle === name);
  });

  const capped = selected.length > DOGFOOD_TRIGGER_CAP;
  if (capped) {
    selected.length = DOGFOOD_TRIGGER_CAP;
  }

  const results: DomainLoopTriggerRow[] = [];
  for (const loop of selected) {
    const result = await triggerSamLoop({
      projectId: project.id,
      loopId: loop.id,
      organizationId: project.organizationId,
    });
    results.push({
      loopId: loop.id,
      loopName: loop.name,
      skillName: loop.skillName,
      result,
    });
  }

  return {
    ok: true,
    projectId: project.id,
    projectName: project.name,
    domain: project.domain,
    seeded: seeded.length,
    capped,
    results,
  };
}

export const SamLoopService = {
  listSamLoopsForProject,
  getContentVelocity,
  listAvailableSamLoopSkills,
  createSamLoop,
  updateSamLoop,
  getSamLoopRuns,
  getSamLoopRun,
  triggerSamLoop,
  triggerSamLoopsForDomain,
  seedDefaultSamLoopsForProject,
  getOrganizationIdForProject,
};
