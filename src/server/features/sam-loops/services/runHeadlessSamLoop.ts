import { generateText, Output, stepCountIs, type StepResult, type ToolSet } from "ai";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { selectMonthlyTopic } from "./monthlyTopic";
import { loopPartialReport } from "./loopPartialReport";
import { MONTHLY_CONTENT_INSTRUCTION, monthlyContentSchema, stripDraftEvidence, validateMonthlyContent, verifiedMonthlyTopics } from "./monthlyContentResult";
import { SamLoopRepository } from "../repositories/SamLoopRepository";
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
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { checkAuditReadiness } from "./loopFreshness";
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
  "Use these report sections: Measurements (with dates), Findings, Queued or proposed, Not measured, Next action.",
  "Keep the final report under 250 words and any table to at most 8 rows. Combine repeated gaps; do not repeat the prompt or tool output.",
  "Keep tool arguments concise. Avoid long narrative inside tool calls. Finish with the report within the existing step limit.",
  "State each source's measurement date. Saved context is background, not a current measurement.",
  "A baseline alone is not proof of improved rankings or AI visibility; comparisons need matching dated samples.",
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
  onProgress?: (progress: Pick<HeadlessSamLoopResult, "report" | "stepsUsed" | "proposalsQueued" | "costNote">) => Promise<void>;
};

export type HeadlessSamLoopResult = {
  status: "completed" | "failed";
  error: string | null;
  report: string;
  stepsUsed: number;
  proposalsQueued: number;
  costNote: string | null;
};

const GENERATION_ERROR_NAME_ALLOWLIST = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "AbortError",
  "TimeoutError",
  "DOMException",
  "AI_NoObjectGeneratedError",
  "AI_APICallError",
  "AI_RetryError",
  "AI_TypeValidationError",
  "AI_JSONParseError",
  "AI_InvalidPromptError",
  "AI_InvalidArgumentError",
  "AI_NoSuchToolError",
  "AI_InvalidToolArgumentsError",
  "AI_ToolExecutionError",
  "AI_NoOutputGeneratedError",
  "AI_NoContentGeneratedError",
  "AI_UnsupportedFunctionalityError",
  "AI_EmptyResponseBodyError",
  "AI_NoSuchModelError",
  "AI_InvalidResponseDataError",
  "AI_DownloadError",
  "AI_MessageConversionError",
]);

function generationErrorDetail(error: unknown): string {
  // Only these fields may reach run records or Slack; never serialize the error.
  // Provider error text, not attacker prose: plain unlabeled hunter2 is undetectable
  // and out of scope. Credential shapes, labels, userinfo and bounded lookback are covered.
  try {
    const labels = ["bearer", "basic", "authorization", "token", "secret", "password", "passwd", "passphrase", "passcode", "pwd", "apikey", "apitoken", "privatekey", "cookie", "credential", "signature", "session"];
    const digitLetters: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "$": "s" };
    const foldDigits = (word: string) => word.replace(/[013457$]/g, digit => digitLetters[digit]!);
    const hasCredentialLabel = (word: string, next = "") => {
      const normalized = word.toLowerCase().replace(/[^a-z0-9$]/g, "");
      const folded = foldDigits(normalized);
      return [normalized, folded].some(value => labels.some(label => value.includes(label)) || value.includes("key"))
        || (folded === "api" && /^keys?$/i.test(foldDigits(next).replace(/[.,;:]+$/, "")));
    };
    const secretDelimiters = /[._~+-]/;
    const knownSecretPrefix = new RegExp(`(?:^|${secretDelimiters.source})(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[a-z]|glpat|npm|shpat|whsec|sk_live|sk_test)(?:${secretDelimiters.source}|$)`, "i");
    const hasSecretShape = (word: string) => {
      let randomLookingRuns = 0;
      for (const run of word.match(/[A-Za-z0-9]+/g) ?? []) {
        // Look ahead so adjacent case flips sharing a character are all counted.
        const caseFlips = (run.match(/[a-z](?=[A-Z])|[A-Z](?=[a-z])/g) ?? []).length;
        const mixed = /[A-Za-z]/.test(run) && /[0-9]/.test(run);
        if (run.length >= 24 || (run.length >= 12 && (mixed || caseFlips >= 4))) return true;
        if ((run.length >= 8 && caseFlips >= 3) || (run.length >= 6 && mixed)) randomLookingRuns++;
      }
      return randomLookingRuns >= 2 || word.split("/").some(segment =>
        /AKIA|ASIA|AIza|eyJ/.test(segment) || knownSecretPrefix.test(segment));
    };
    const record = error != null && typeof error === "object" ? error as Record<string, unknown> : null;
    const name = typeof record?.name === "string" && (GENERATION_ERROR_NAME_ALLOWLIST.has(record.name)
      || /^[A-Za-z_$][\w.$]{0,79}$/.test(record.name) && !hasCredentialLabel(record.name) && !hasSecretShape(record.name))
      ? record.name : error instanceof Error ? "Error" : "NonError";
    const status = [record?.statusCode, record?.status].find((value): value is number =>
      typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599);
    const message = typeof record?.message === "string" ? record.message : typeof error === "string" ? error : "Unknown error";
    const redact = (value: string) => {
      // Bound scanning, then stop before Unicode separators or look-alikes.
      let text = value.slice(0, 2000);
      const nonAscii = text.search(/[^\x20-\x7E\t\r\n]/);
      if (nonAscii !== -1) {
        let wordStart = nonAscii;
        while (wordStart > 0 && !/[ \t\r\n]/.test(text[wordStart - 1]!)) wordStart--;
        text = text.slice(0, wordStart);
      }
      let suspicious = false;
      const words = text.split(/[ \t\r\n]+/);
      const output: string[] = [];
      const readable = (word: string) => {
        const remainder = word.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "");
        const path = remainder !== word || remainder.includes("/");
        return !remainder.includes(":") && (path
            ? /^[A-Za-z0-9._\/+~-]{1,60}$/.test(remainder) && remainder.split("/").every(segment => segment.length < 32)
            : /^[A-Za-z0-9._\/+~-]{1,31}$/.test(remainder));
      };
      for (let index = 0; index < words.length; index++) {
        let word = words[index]!;
        if (!word) continue;
        let end = word.length;
        while (end > 0 && ".,;:".includes(word[end - 1]!)) end--;
        const punctuation = word.slice(end);
        word = word.slice(0, end);
        // Any ampersand may introduce an entity, including incomplete or split ones.
        if (/[@=&$!*^(){}\[\]<>"'\x60|\\]/.test(word)
          || /.\+.|^\+[a-z]+-/i.test(words[index]!)
          || /%(?!3f|23)(?:[0-9a-f]{2}|u[0-9a-f]{4}|u)/i.test(words[index]!)) {
          // Split userinfo or assignments may include two preceding words.
          output.pop();
          output.pop();
          suspicious = true;
          break;
        }
        if (hasCredentialLabel(word, words[index + 1]) || hasSecretShape(word)) {
          output.pop();
          suspicious = true;
          break;
        }
        const cut = word.search(/[?#]|%3[fF]|%23/);
        if (cut !== -1) {
          const prefix = word.slice(0, cut);
          if (prefix && readable(prefix)) output.push(prefix);
          suspicious = true;
          break;
        }
        if (!readable(word)) {
          suspicious = true;
          break;
        }
        output.push(word + punctuation);
      }
      if (!suspicious && nonAscii !== -1) {
        output.pop();
        output.pop();
        suspicious = true;
      }
      if (suspicious) output.push("[redacted]");
      return output.join(" ").trim().slice(0, 200);
    };
    return `${GENERATION_ERROR_NAME_ALLOWLIST.has(name) ? name : redact(name)}${status === undefined ? "" : ` (HTTP ${status})`}: ${redact(message).slice(0, 200)}`;
  } catch {
    return "UnknownError: Unreadable error details";
  }
}

/**
 * Run Sam once for a loop: project system prompt + skill/custom body,
 * propose-only write path, step cap 24.
 */
export async function runHeadlessSamLoop(
  input: HeadlessSamLoopInput,
): Promise<HeadlessSamLoopResult> {
  for (const key of ["ANTHROPIC_API_KEY", "XAI_API_KEY", "OPENAI_API_KEY"]) {
    if (Reflect.has(env, key) || (typeof process !== "undefined" && key in process.env)) {
      throw new Error("API-key environment refused; subscriptions only.");
    }
  }
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

  const monthlyTemplate = DEFAULT_SAM_LOOP_TEMPLATES.find((template) => template.name === "Monthly content");
  const monthly = input.sourceType === "custom" && !!input.customPrompt && input.customPrompt === monthlyTemplate?.customPrompt;
  const needsAudit = !monthly && (
    (input.sourceType === "skill" && ["site-health", "seo-audit", "niceseo-pillars", "page-growth", "ai-visibility"].includes(input.skillName ?? "")) ||
    (input.sourceType === "custom" && /\bget_audit_(?:status|pages|issues)\b|\bseo-audit\b/i.test(input.customPrompt ?? ""))
  );
  let crawlEvidence: string | null = null;
  let staleNotice = "";
  if (needsAudit) {
    let readiness: ReturnType<typeof checkAuditReadiness>;
    try {
      const audit = await AuditRepository.getLatestAuditForProject(input.project.id);
      const pages = audit ? await AuditRepository.getPagesForAudit(audit.id) : [];
      readiness = checkAuditReadiness(audit, pages, row!.domain, new Date(), {
        allowStale: await getOptionalEnvValue("SAM_LOOP_ALLOW_STALE_AUDIT") === "true",
      });
    } catch {
      readiness = { ready: false, reason: "The saved crawl could not be read." };
    }
    if (!readiness.ready) {
      return {
        status: "failed",
        error: `Current crawl input unavailable: ${readiness.reason}`,
        report: `Current crawl input unavailable: ${readiness.reason} Refresh and verify the site crawl before trying again. No model or research tools were called.`,
        stepsUsed: 0, proposalsQueued: 0, costNote: "no model call",
      };
    }
    crawlEvidence = `Crawl input checked before this run: measured ${readiness.measuredAt}; ${readiness.usablePages} usable own-site pages. This proves usable crawl input only, not complete site coverage or site health. Read the same current audit through the tools before drawing conclusions.`;
    if (readiness.stale) {
      staleNotice = `STALE AUDIT — measured ${readiness.measuredAt}; age ${readiness.stale.ageDays.toFixed(1)} days. Historical evidence only; current page state is not verified.\n\n`;
      crawlEvidence = staleNotice + crawlEvidence;
    }
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
        domain: row!.domain,
        locationCode: input.project.locationCode,
        languageCode: input.project.languageCode,
      },
      { intakeMode },
    ),
    contextMarkdown ? `Project context:\n${contextMarkdown}` : null,
    crawlEvidence,
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
      domain: row!.domain,
    }),
    {
      sourceType: input.sourceType,
      customPrompt: input.customPrompt,
      loopName: input.loopName,
    },
  );

  let topic: Awaited<ReturnType<typeof selectMonthlyTopic>> | null = null;
  if (monthly) {
    try {
      const history = await SamLoopRepository.getCompletedMonthlyReports(input.project.id);
      if (history.length > 500) throw new Error("History scan incomplete");
      topic = await selectMonthlyTopic(tools, await verifiedMonthlyTopics(history));
    } catch {
      return {
        status: "failed", error: "Verified monthly draft history could not be fully checked.",
        report: "Monthly article not completed: verified draft history is unavailable or exceeds the bounded scan. No model was called; prior topics were not guessed.",
        stepsUsed: 0, proposalsQueued: 0, costNote: "no model call",
      };
    }
  }
  if (topic && topic.status !== "ready") {
    const noData = topic.status === "no_data";
    const exhausted = topic.status === "no_new_topic";
    return {
      status: noData || exhausted ? "completed" : "failed",
      error: noData || exhausted ? null : "Monthly topic sources could not all be checked.",
      report: topic.status === "no_new_topic"
        ? `NO NEW TOPIC — all ${topic.candidateCount} available client topics already have verified monthly drafts. No article or model call was made. Add a new client-owned topic to continue.`
        : noData
        ? "NO DATA — no saved keywords, tracked terms or Search Console queries are available. No article was generated or published. Add a client keyword or connect Search Console. Existing content holds remain in force."
        : "Monthly article not completed: topic data was unavailable or the bounded source scan was incomplete. Retry the free readers; do not invent a target. No model was called.",
      stepsUsed: 0, proposalsQueued: 0, costNote: "no model call",
    };
  }
  if (topic?.status === "ready") {
    taskBody += `\n\nSelected targetKeyword: ${JSON.stringify(topic.keyword)}. This exact term was read from this project's saved first-party data before generation. Use it unchanged. Other saved context and content holds still apply.`;
  }

  // Headless loops ship a unique skill dump + ~30 tool schemas. Anthropic
  // prompt-cache breakpoints on that payload overflow the 4-block cap
  // (live niceseo.ai AI-visibility run 2026-09-01: "Found 5"). Loops also
  // almost never reuse the same prefix, so cache writes are pure cost.
  const model = await getChatAgentModel({ promptCache: false });
  const finishedSteps: StepResult<ToolSet>[] = [];
  let checkpointFailures = 0;
  const checkpointNote = () => checkpointFailures ? `; progress checkpoint failures: ${checkpointFailures}` : "";
  const progress = () => {
    const knownCost = finishedSteps.reduce((sum, step) => sum + openRouterCostUsd(step.providerMetadata), 0);
    return {
      report: staleNotice + loopPartialReport(finishedSteps),
      stepsUsed: finishedSteps.length,
      proposalsQueued: countProposalsQueued(finishedSteps),
      costNote: (knownCost > 0 ? `OpenRouter recorded steps ≈ $${knownCost.toFixed(4)}; unfinished-step cost unavailable` : "Generation incomplete; final cost unavailable") + checkpointNote(),
    };
  };
  let result;
  try {
    result = await generateText({
    model,
    system,
    prompt: taskBody,
    tools,
    // Verified route support: MiniMax M3 allows >8k completion tokens. Keep
    // unknown overrides at the previous cap. This adds no model calls.
    maxOutputTokens: model.modelId === "minimax/minimax-m3" ? 8000 : 4000,
    stopWhen: stepCountIs(SAM_LOOP_STEP_CAP),
    ...(topic?.status === "ready" ? { output: Output.object({ schema: monthlyContentSchema.extend({ targetKeyword: z.literal(topic.keyword) }) }) } : {}),
    onStepFinish: async (step) => {
      finishedSteps.push(step);
      try {
        await input.onProgress?.(progress());
      } catch {
        checkpointFailures += 1;
        console.warn("[sam-loop] Progress checkpoint failed; continuing to final report persistence.");
      }
    },
    });
  } catch (error) {
    return {
      status: "failed",
      error: `Generation did not return a complete valid result. ${generationErrorDetail(error)}`,
      ...progress(),
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
    report = loopPartialReport(result.steps, report);
  } else if (monthly) {
    try {
      const article = await validateMonthlyContent(result.output, [...(topic?.evidence ?? []), ...result.steps], row!.domain ?? "");
      report = article.report;
      error = article.error;
    } catch (generationError) {
      error = `The run did not finish a valid structured article result. ${generationErrorDetail(generationError)}`;
    }
  } else if (!report) {
    error = "The run ended without a written report.";
  }
  if (error && monthly && !report.startsWith("INCOMPLETE")) report = `Monthly article not completed: ${error}\n\n${loopPartialReport(result.steps)}`;
  if (!report) report = `Not measured — ${error}`;

  let costNote: string | null = null;
  if (costUsd > 0) {
    costNote = `OpenRouter ≈ $${costUsd.toFixed(4)}`;
  }
  if (checkpointFailures) costNote = (costNote ?? "Model cost unavailable") + checkpointNote();

  return {
    status: error ? "failed" : "completed",
    error,
    report: staleNotice + report,
    stepsUsed: result.steps.length,
    proposalsQueued,
    costNote,
  };
}
