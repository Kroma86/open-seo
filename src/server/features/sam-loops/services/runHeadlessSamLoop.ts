import { generateText, stepCountIs } from "ai";
import { openRouterCostUsd } from "@/server/lib/chatAgent";
import { getChatAgentModel } from "@/server/lib/openrouter";
import { buildSamMcpTools } from "@/server/features/sam/samChatTools";
import { buildSamSkillSource } from "@/server/features/sam/samSkills";
import { buildSamSystemPrompt } from "@/server/features/sam/samSystemPrompt";
import { ProjectContextService } from "@/server/features/project-context/services/ProjectContextService";
import type { ToolAuthContext } from "@/server/mcp/context";
import { filterLoopTools } from "@/server/features/sam-loops/services/loopToolFilter";
import { countProposalsQueued } from "@/server/features/sam-loops/services/countProposalsQueued";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import {
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
  "This project is allowed to run. Do the loop work. Do not stop just because the domain is not niceseo.ai, twa.studio, or niceapp.ai.",
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

  let taskBody: string;
  if (input.sourceType === "skill" && input.skillName) {
    const skill = await buildSamSkillSource().load(input.skillName);
    if (!skill) {
      throw new Error(`Unknown skill: ${input.skillName}`);
    }
    taskBody = `Loop: ${input.loopName}\n\nActivate and follow this skill:\n\n# ${skill.name}\n\n${skill.body}`;
  } else if (input.customPrompt) {
    taskBody = `Loop: ${input.loopName}\n\n${input.customPrompt}`;
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
    LOOP_REPORT_INSTRUCTION,
  ]
    .filter(Boolean)
    .join("\n\n");

  const tools = filterLoopTools(
    buildSamMcpTools(input.authContext, {
      id: input.project.id,
      domain: input.project.domain,
    }),
  );

  // Headless loops ship a unique skill dump + ~30 tool schemas. Anthropic
  // prompt-cache breakpoints on that payload overflow the 4-block cap
  // (live niceseo.ai AI-visibility run 2026-09-01: "Found 5"). Loops also
  // almost never reuse the same prefix, so cache writes are pure cost.
  const model = await getChatAgentModel({ promptCache: false });
  const result = await generateText({
    model,
    system,
    prompt: taskBody,
    tools,
    maxOutputTokens: 4000,
    stopWhen: stepCountIs(SAM_LOOP_STEP_CAP),
  });

  const costUsd = result.steps.reduce(
    (sum, step) => sum + openRouterCostUsd(step.providerMetadata),
    0,
  );
  const proposalsQueued = countProposalsQueued(result.steps);
  const report =
    result.text.trim() ||
    "not measured — the loop finished without a written report.";

  let costNote: string | null = null;
  if (costUsd > 0) {
    costNote = `OpenRouter ≈ $${costUsd.toFixed(4)}`;
  }

  return {
    report,
    stepsUsed: result.steps.length,
    proposalsQueued,
    costNote,
  };
}
