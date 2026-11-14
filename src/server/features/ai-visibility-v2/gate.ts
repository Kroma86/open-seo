import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  aiVisibilityConfigs,
  aiVisibilityPrompts,
  measurementQuestions,
  projects,
} from "@/db/schema";
import { getProjectContext } from "@/server/features/project-context/services/ProjectContextService";
import { AiVisibilityManagementService } from "@/server/features/ai-visibility/services/AiVisibilityManagementService";
import { pausedScheduledSeoProjects } from "@/server/features/projects/services/scheduledSeoPauses";
import { customerHasPaidPlan } from "@/server/billing/subscription";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { sha256, estimateAnswers, type Enrollment } from "./policy";

export async function measurementGate(e: Enrollment, now: Date) {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, e.projectId));
  const [config] = await db
    .select()
    .from(aiVisibilityConfigs)
    .where(
      and(
        eq(aiVisibilityConfigs.id, e.configId),
        eq(aiVisibilityConfigs.projectId, e.projectId),
      ),
    );
  if (
    !project ||
    project.archivedAt ||
    project.domain !== e.domain ||
    !config?.isActive ||
    !config.brand.trim() ||
    pausedScheduledSeoProjects(now.toISOString()).includes(e.projectId)
  )
    throw new Error("Project or config held or mismatched");
  const evidence = JSON.parse(e.eligibilityEvidence) as unknown;
  // Owner-checked receipt hash detects drift; it does not authenticate its claims.
  const receipt = z
    .object({
      projectId: z.string().uuid(),
      domain: z.string(),
      frozenLaneAllowed: z.literal(true),
      held: z.literal(false),
      neverClient: z.literal(false),
      source: z.string().min(1),
      verifiedAt: z.iso.datetime(),
    })
    .parse(evidence);
  if (
    receipt.projectId !== e.projectId ||
    receipt.domain !== e.domain ||
    receipt.verifiedAt !== e.verifiedAt ||
    (await sha256(e.eligibilityEvidence)) !== e.eligibilityHash
  )
    throw new Error("Eligibility receipt mismatch");
  const context = await getProjectContext(e.projectId);
  const stableContext = JSON.stringify({
    sections: [...context.sections].toSorted((a, b) =>
      a.key.localeCompare(b.key),
    ),
    customSections: [...context.customSections].toSorted((a, b) =>
      a.slug.localeCompare(b.slug),
    ),
    keyPages: [...context.keyPages].toSorted((a, b) =>
      a.id.localeCompare(b.id),
    ),
  });
  if (
    !context.sections.some(
      (s) => s.key === "business_overview" && s.content.trim(),
    ) ||
    (await sha256(stableContext)) !== e.contextHash
  )
    throw new Error("Current project Context missing or changed");
  const questions = await db
    .select()
    .from(measurementQuestions)
    .where(eq(measurementQuestions.projectId, e.projectId));
  const prompts = await db
    .select()
    .from(aiVisibilityPrompts)
    .where(eq(aiVisibilityPrompts.configId, e.configId));
  if (
    questions.filter((q) => q.kind === "active").length !== 10 ||
    questions.filter((candidate) => candidate.kind === "approved_context")
      .length > 5
  )
    throw new Error(
      "Require ten active stored questions and at most five approved Context questions",
    );
  for (const q of questions) {
    const p = prompts.find((source) => source.id === q.promptId);
    if (
      !p ||
      p.prompt !== q.prompt ||
      !q.prompt.trim() ||
      q.prompt.length > 2000 ||
      (q.kind === "active" && !p.isActive) ||
      (q.kind === "approved_context" && !q.approvalEvidence?.trim())
    )
      throw new Error("Stored question lacks current source or approval");
  }
  for (const q of questions.filter(
    (candidate) => candidate.kind === "approved_context",
  )) {
    const approval = z
      .object({
        promptId: z.string(),
        contextHash: z.string(),
        kind: z.literal("service_town"),
        approved: z.literal(true),
        source: z.string().min(1),
      })
      .parse(JSON.parse(q.approvalEvidence ?? "null"));
    if (
      approval.promptId !== q.promptId ||
      approval.contextHash !== e.contextHash
    )
      throw new Error("Question approval does not cover current Context");
  }
  await AiVisibilityManagementService.requireAiVisibilityAccess(
    project.organizationId,
  );
  if (
    (await isHostedServerAuthMode()) &&
    !(await customerHasPaidPlan(project.organizationId, { retryDenied: true }))
  )
    throw new Error("Plan does not permit measurement");
  return {
    project,
    config,
    questions,
    fingerprint: await sha256(
      JSON.stringify({
        projectId: e.projectId,
        domain: e.domain,
        contextHash: e.contextHash,
        eligibilityHash: e.eligibilityHash,
        brand: config.brand,
        locationCode: project.locationCode,
        languageCode: project.languageCode,
        questions: [...questions].toSorted((a, b) => a.id.localeCompare(b.id)),
      }),
    ),
    estimate: estimateAnswers(questions.length),
  };
}
