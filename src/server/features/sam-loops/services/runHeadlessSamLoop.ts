import { generateText, Output, stepCountIs, type StepResult, type ToolSet } from "ai";
import { MONTHLY_CONTENT_INSTRUCTION, monthlyContentSchema, stripDraftEvidence, validateMonthlyContent } from "./monthlyContentResult";
import { openRouterCostUsd } from "@/server/lib/chatAgent";
import { getChatAgentModel } from "@/server/lib/openrouter";
import { buildSamMcpTools } from "@/server/features/sam/samChatTools";
import { buildSamSkillSource } from "@/server/features/sam/samSkills";
import { buildSamSystemPrompt } from "@/server/features/sam/samSystemPrompt";
import { ProjectContextService } from "@/server/features/project-context/services/ProjectContextService";
import type { ToolAuthContext } from "@/server/mcp/context";
import { buildScopedLoopTools } from "@/server/features/sam-loops/services/loopToolFilter";
import { countProposalsQueued } from "@/server/features/sam-loops/services/countProposalsQueued";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import {
  DEFAULT_SAM_LOOP_TEMPLATES,
  isSamLoopProjectAllowed,
  SAM_LOOP_ALLOWED_DOMAINS,
  SAM_LOOP_STEP_CAP,
} from "@/shared/sam-loops";

const LOOP_REPORT_INSTRUCTION = [
  "You are running as a scheduled Sam Loop (headless — no chat user).",
  "Use tools as needed, then finish with a short plain-English run report",
  "(grade-9 reading level). State only what tools returned; if something was",
  "not measured, say \"not measured\". Do not claim deploys or live changes.",
  "The only allowed write is propose_homegrown_otto_fixes (queues proposals).",
  "If you spend paid credits, say so in the report. End with the report as",
  "your final message — no tool calls after the synthesis.",
  "Do the loop work for this project's own domain.",
].join(" ");

export type HeadlessSamLoopInput = {
  project: {
    id: string;
    name: string;
    domain: string | null;
    locationCode: number;
    languageCode: string;
    loopsEnabled?: boolean | null;
  };
  authContext: ToolAuthContext;
  sourceType: "skill" | "custom";
  skillName: string | null;
  customPrompt: string | null;
  loopName: string;
};

export type HeadlessSamLoopResult = {
  status: "completed" | "failed";
  error: string | null;
  report: string;
  stepsUsed: number;
  proposalsQueued: number;
  costNote: string | null;
};

/**
 * Run Sam once for a loop: project system prompt + skill/custom body,
 * propose-only write path, step cap 24.
 */
export async function runHeadlessSamLoop(
  input: HeadlessSamLoopInput,
): Promise<HeadlessSamLoopResult> {
  const row = await ProjectRepository.getProjectById(input.project.id);
  const allowed =
    row != null &&
    row.archivedAt == null &&
    isSamLoopProjectAllowed({
      domain: row.domain,
      loopsEnabled: row.loopsEnabled,
    });
  if (!allowed) {
    return {
      status: "failed",
      error: "Loop is not enabled for this project.",
      report: `Loop not enabled for this domain (${row?.domain ?? "no domain"}). Allowed: the house domains or a project Jon enabled for loops (${SAM_LOOP_ALLOWED_DOMAINS.join(", ")}). No tools were called.`,
      stepsUsed: 0,
      proposalsQueued: 0,
      costNote: "no model call",
    };
  }

  const context = await ProjectContextService.getProjectContext(
    input.project.id,
  );
  const intakeMode = context.missingSections.includes("business_overview");
  const contextMarkdown =
    ProjectContextService.renderProjectContextMarkdown(context);

  const monthlyTemplate = DEFAULT_SAM_LOOP_TEMPLATES.find((template) => template.name === "Monthly content");
  const monthly = input.sourceType === "custom" && !!input.customPrompt && input.customPrompt === monthlyTemplate?.customPrompt;
  let taskBody: string;
  if (input.sourceType === "skill" && input.skillName) {
    const skill = await buildSamSkillSource().load(input.skillName);
    if (!skill) {
      throw new Error(`Unknown skill: ${input.skillName}`);
    }
    taskBody = `Loop: ${input.loopName}\n\nActivate and follow this skill:\n\n# ${skill.name}\n\n${skill.body}`;
  } else if (monthly) {
    taskBody = `Loop: ${input.loopName}\n\n${MONTHLY_CONTENT_INSTRUCTION}`;
  } else if (input.customPrompt) {
    const onPageTemplate = DEFAULT_SAM_LOOP_TEMPLATES.find(
      (template) => template.name === "On-page priorities",
    );
    let executionPrompt = input.customPrompt;
    if (
      input.sourceType === "custom" &&
      input.customPrompt === onPageTemplate?.customPrompt
    ) {
      // Preserve the reserved stored identity used to grant proposal access.
      // A completed skip report must never suppress the next scheduled pass.
      const bodyStart = input.customPrompt.indexOf("Queue-only on-page pass");
      if (bodyStart < 0) throw new Error("On-page execution template is missing");
      executionPrompt = [
        "Perform this pass on every scheduled run. The configured cadence controls timing.",
        "First list existing proposals. Skip a page/field when the same replacement is already pending or approved.",
        input.customPrompt.slice(bodyStart),
      ].join("\n\n");
    }
    taskBody = `Loop: ${input.loopName}\n\n${executionPrompt}`;
  } else {
    throw new Error("Loop has neither skill nor custom prompt");
  }

  const system = [
    buildSamSystemPrompt(
      {
        projectId: input.project.id,
        projectName: input.project.name,
        domain: input.project.domain,
        locationCode: input.project.locationCode,
        languageCode: input.project.languageCode,
      },
      { intakeMode },
    ),
    contextMarkdown ? `Project context:\n${contextMarkdown}` : null,
    monthly ? [
      "You are running a scheduled monthly article task, with no chat user.",
      "For this task override chat brevity: finish with the full structured article object,",
      "including the complete body, sources and outcome, not a short run report.",
      "Use only free first-party reading tools. Do not publish, propose changes or claim unmeasured results.",
      "When evidence is missing, return the structured blocked outcome and explain the missing evidence.",
    ].join(" ") : LOOP_REPORT_INSTRUCTION,
  ]
    .filter(Boolean)
    .join("\n\n");

  const tools = buildScopedLoopTools(
    buildSamMcpTools(input.authContext, {
      id: input.project.id,
      domain: input.project.domain,
    }),
    {
      sourceType: input.sourceType,
      customPrompt: input.customPrompt,
      loopName: input.loopName,
    },
  );

  // Headless loops ship a unique skill dump + ~30 tool schemas. Anthropic
  // prompt-cache breakpoints on that payload overflow the 4-block cap
  // (live niceseo.ai AI-visibility run 2026-09-01: "Found 5"). Loops also
  // almost never reuse the same prefix, so cache writes are pure cost.
  const model = await getChatAgentModel({ promptCache: false });
  const finishedSteps: StepResult<ToolSet>[] = [];
  let result;
  try {
    result = await generateText({
    model,
    system,
    prompt: taskBody,
    tools,
    maxOutputTokens: 4000,
    stopWhen: stepCountIs(SAM_LOOP_STEP_CAP),
    ...(monthly ? { output: Output.object({ schema: monthlyContentSchema }) } : {}),
    onStepFinish: (step) => { finishedSteps.push(step); },
    });
  } catch {
    const knownCost = finishedSteps.reduce((sum, step) => sum + openRouterCostUsd(step.providerMetadata), 0);
    return {
      status: "failed",
      error: "Generation did not return a complete valid result.",
      report: "The run did not finish a complete valid result. Completed tool steps may have incurred charges; no completed draft is claimed.",
      stepsUsed: finishedSteps.length,
      proposalsQueued: countProposalsQueued(finishedSteps),
      costNote: knownCost > 0 ? `OpenRouter recorded steps ≈ $${knownCost.toFixed(4)}; unfinished-step cost unavailable` : "Generation failed; final cost unavailable",
    };
  }

  const costUsd = result.steps.reduce(
    (sum, step) => sum + openRouterCostUsd(step.providerMetadata),
    0,
  );
  const proposalsQueued = countProposalsQueued(result.steps);
  let report = stripDraftEvidence(result.text ?? "");
  let error: string | null = null;
  if (result.finishReason && result.finishReason !== "stop") {
    error = `The model did not finish normally (${result.finishReason}); the report is incomplete.`;
  } else if (monthly) {
    try {
      const article = await validateMonthlyContent(result.output, result.steps, row!.domain ?? "");
      report = article.report;
      error = article.error;
    } catch {
      error = "The run did not finish a valid structured article result.";
    }
  } else if (!report) {
    error = "The run ended without a written report.";
  }
  if (error && monthly) report = `Monthly article not completed: ${error}`;
  if (!report) report = `Not measured — ${error}`;

  let costNote: string | null = null;
  if (costUsd > 0) {
    costNote = `OpenRouter ≈ $${costUsd.toFixed(4)}`;
  }

  return {
    status: error ? "failed" : "completed",
    error,
    report,
    stepsUsed: result.steps.length,
    proposalsQueued,
    costNote,
  };
}
