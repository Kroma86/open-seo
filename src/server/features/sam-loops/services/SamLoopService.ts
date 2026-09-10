import { stripDraftEvidence } from "./monthlyContentResult";
import { env } from "cloudflare:workers";
import { AppError } from "@/server/lib/errors";
import { SamLoopRepository } from "@/server/features/sam-loops/repositories/SamLoopRepository";
import {
  beginSamLoopRun,
  getSamLoopDailyRunCap,
} from "@/server/features/sam-loops/services/samLoopRunGuards";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { getAgencyScoreInputsGlobal } from "@/server/features/agency/AgencyScoreInputsService";
import { buildSamSkillSource } from "@/server/features/sam/samSkills";
import {
  DEFAULT_SAM_LOOP_TEMPLATES,
  DOGFOOD_SAM_LOOP_TRIGGER_CAP,
  computeNextSamLoopRunAt,
  expectedSamLoopDraftsPerMonth,
  isSamContentLoop,
  isSamLoopProjectAllowed,
  startOfUtcDay,
} from "@/shared/sam-loops";
import type { ContentVelocity } from "@/types/schemas/sam-loops";
import type {
  SamLoopTriggerResult,
  createSamLoopSchema,
  updateSamLoopSchema,
} from "@/types/schemas/sam-loops";
import type { z } from "zod";

function publicRun<T extends { report: string | null }>(run: T): T {
  return { ...run, report: run.report === null ? null : stripDraftEvidence(run.report) };
}

/** Pure list — defaults are seeded on project create, not on every read. */
export async function listSamLoopsForProject(projectId: string) {
  const loops = await SamLoopRepository.getLoopsForProject(projectId);
  const runs = await SamLoopRepository.getRecentRunsForProject({
    projectId,
    limit: 40,
  });
  return { loops, runs: runs.map(publicRun) };
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

export async function listAvailableSamLoopSkills() {
  const skills = await buildSamSkillSource().list();
  return skills;
}

/** Approved template prompts are reserved for seeded loops. */
function isReservedTemplatePrompt(prompt: string | null | undefined): boolean {
  return (
    prompt != null &&
    DEFAULT_SAM_LOOP_TEMPLATES.some(
      (t) => t.sourceType === "custom" && t.customPrompt === prompt,
    )
  );
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

  // Approved template prompts are reserved: a user-created custom loop may not
  // carry one verbatim (the prompt text is in the client bundle, so byte-matching
  // is otherwise spoofable). Seeded loops bypass this path via the repository.
  if (input.sourceType === "custom" && input.customPrompt) {
    if (isReservedTemplatePrompt(input.customPrompt)) {
      throw new AppError(
        "VALIDATION_ERROR",
        "This prompt matches an approved template. Use the starter-loops button to add it instead of creating a custom loop.",
      );
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
    nextRunAt: computeNextSamLoopRunAt(
      input.cadence,
      undefined,
      `${input.projectId}:${input.name}`,
    ),
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

  // Same reserved-prompt rule as createSamLoop, on the update path: reject a
  // prompt CHANGE that lands on an approved template verbatim — unless the
  // loop already lives in the template family (it holds a template prompt
  // today). The carve-out keeps template loops repairable and grants no
  // CAPABILITY the starter-loops button doesn't grant. Cadence is
  // independently user-editable on every loop, so a swap can compose a
  // template's capabilities with a schedule the seeded template doesn't ship
  // (e.g. daily) — accepted: the per-run tool call caps, not the seeded
  // cadence, are the cost control. A loop whose prompt was edited AWAY from
  // its template has left the family; the repair path then is delete + re-add
  // from the starter loops.
  if (
    input.customPrompt !== undefined &&
    input.customPrompt !== existing.customPrompt &&
    isReservedTemplatePrompt(input.customPrompt) &&
    !isReservedTemplatePrompt(existing.customPrompt)
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "This prompt matches an approved template. A custom loop cannot take a template's prompt. If this loop started from a template and you want it back, delete it and re-add it from the starter loops.",
    );
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
    // Re-anchor schedule when cadence changes. The seed follows the FINAL
    // name so future advances (which use the stored name) stay on one date.
    patch.nextRunAt = computeNextSamLoopRunAt(
      cadence,
      undefined,
      `${existing.projectId}:${input.name ?? existing.name}`,
    );
  }

  // Enabling a loop that has no nextRunAt (or was never scheduled) schedules it.
  if (input.isEnabled === true && !existing.nextRunAt) {
    patch.nextRunAt = computeNextSamLoopRunAt(
      cadence,
      undefined,
      `${existing.projectId}:${input.name ?? existing.name}`,
    );
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
    const runs = await SamLoopRepository.getRunsForLoop({
      loopId: input.loopId,
      projectId: input.projectId,
      limit: input.limit,
    });
    return runs.map(publicRun);
  }
  const runs = await SamLoopRepository.getRecentRunsForProject({
    projectId: input.projectId,
    limit: input.limit,
  });
  return runs.map(publicRun);
}

export async function getSamLoopRun(input: {
  projectId: string;
  runId: string;
}) {
  const run = await SamLoopRepository.getRunById(input.runId);
  if (!run || run.projectId !== input.projectId) {
    throw new AppError("NOT_FOUND", "Run not found");
  }
  return publicRun(run);
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
  | { ok: false; reason: "project_not_found" | "domain_not_allowed" | "daily_cap" }
  | {
      ok: false;
      reason: "ambiguous_project_domain";
      count: number;
    }
  | {
      ok: true;
      projectId: string;
      projectName: string;
      domain: string | null;
      seeded: number;
      capped: boolean;
      results: DomainLoopTriggerRow[];
    };

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
 * path so we can fire house-domain loops without Cloudflare Access.
 */
export async function triggerSamLoopsForDomain(input: {
  domain: string;
  names?: string[];
}): Promise<DomainLoopTriggerResult> {
  const domain = normalizeTriggerDomain(input.domain);
  const candidates = await ProjectRepository.getProjectsByDomain(domain);
  if (candidates.length === 0) {
    return { ok: false, reason: "domain_not_allowed" };
  }

  const allowedFlags = candidates.map((row) => isSamLoopProjectAllowed(row));
  const anyAllowed = allowedFlags.some(Boolean);
  const anyDenied = allowedFlags.some((allowed) => !allowed);
  if (anyAllowed && anyDenied) {
    return {
      ok: false,
      reason: "ambiguous_project_domain",
      count: candidates.length,
    };
  }
  if (!anyAllowed) {
    return { ok: false, reason: "domain_not_allowed" };
  }

  const score = await getAgencyScoreInputsGlobal(domain);
  if (!score.projectId) {
    return { ok: false, reason: "project_not_found" };
  }
  const project = await ProjectRepository.getProjectById(score.projectId);
  const candidateIds = new Set(candidates.map((row) => row.id));
  if (
    project == null ||
    !candidateIds.has(project.id) ||
    !isSamLoopProjectAllowed(project)
  ) {
    return { ok: false, reason: "domain_not_allowed" };
  }

  const dailyRunCap = getSamLoopDailyRunCap(env);
  const runsToday = await SamLoopRepository.countRunsCreatedSince(
    startOfUtcDay(),
  );
  if (runsToday >= dailyRunCap) {
    return { ok: false, reason: "daily_cap" };
  }
  const remaining = dailyRunCap - runsToday;

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

  const startCap = Math.min(DOGFOOD_SAM_LOOP_TRIGGER_CAP, remaining);
  const capped = selected.length > startCap;
  if (capped) {
    selected.length = startCap;
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
