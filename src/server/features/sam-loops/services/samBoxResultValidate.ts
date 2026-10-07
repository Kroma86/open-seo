import { z } from "zod";
import { stripDraftEvidence } from "./monthlyContentResult";
import {
  SAM_BOX_KIND_LIMITS,
  SAM_BOX_MAX_REPORT_CHARS,
  type SamBoxKind,
  type SamBoxOutputLimits,
} from "./samBoxTypes";

const resultSchema = z
  .object({
    report: z.string(),
    proposals: z.array(z.unknown()),
  })
  .strict();

const proposalSchema = z
  .object({
    path: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    h1: z.string().optional(),
    before_title: z.string().optional(),
    before_description: z.string().optional(),
    rationale: z.string().optional(),
    human_review: z.array(z.string()).optional(),
  })
  .strict();

export type SamBoxProposal = z.infer<typeof proposalSchema>;
export type SamBoxDropCode =
  | "bad_path"
  | "bad_field"
  | "too_long"
  | "markup"
  | "disallowed_field"
  | "no_fix"
  | "duplicate_path"
  | "over_limit";

type Validation =
  | {
      ok: true;
      report: string;
      proposals: SamBoxProposal[];
      dropped: SamBoxDropCode[];
    }
  | { ok: false; error: string };

const FIX_FIELDS = ["title", "description", "h1"] as const;

export function validateSamBoxResult(
  result: unknown,
  kind: SamBoxKind,
  limits: SamBoxOutputLimits,
): Validation {
  const parsed = resultSchema.safeParse(result);
  if (!parsed.success) {
    if (
      parsed.error.issues.some((issue) => issue.code === "unrecognized_keys")
    ) {
      return { ok: false, error: "Result had unexpected fields." };
    }
    if (
      parsed.error.issues.some(
        (issue) =>
          issue.path[0] === "report" ||
          (issue.code === "invalid_type" && issue.path.length === 0),
      )
    ) {
      return { ok: false, error: "The run ended without a written report." };
    }
    return { ok: false, error: "Result had invalid fields." };
  }
  let report = stripDraftEvidence(parsed.data.report).trim();
  if (!report)
    return { ok: false, error: "The run ended without a written report." };
  const reportMax = Math.min(limits.max_report_chars, SAM_BOX_MAX_REPORT_CHARS);
  if (report.length > reportMax) {
    report =
      report.slice(0, Math.max(0, reportMax - 20)) + "…[truncated by Worker]";
  }

  const kindLimits = SAM_BOX_KIND_LIMITS[kind];
  const maxProposals = Math.min(limits.max_proposals, kindLimits.maxProposals);
  const proposals: SamBoxProposal[] = [];
  const dropped: SamBoxDropCode[] = [];
  const seenPaths = new Set<string>();
  for (const [index, raw] of parsed.data.proposals.entries()) {
    if (index >= maxProposals) {
      dropped.push("over_limit");
      continue;
    }
    const rawPath =
      raw !== null && typeof raw === "object" && "path" in raw
        ? raw.path
        : null;
    const validPath =
      typeof rawPath === "string" &&
      rawPath.startsWith("/") &&
      rawPath.length <= 200 &&
      !/:\/\/|\s|[<>]/.test(rawPath);
    const duplicatePath = validPath && seenPaths.has(rawPath);
    // Invalid fixes or extra fields do not permit a later proposal for the same path.
    if (validPath) seenPaths.add(rawPath);
    const candidate = proposalSchema.safeParse(raw);
    if (!candidate.success) {
      dropped.push(
        candidate.error.issues.some(
          (issue) => issue.code === "unrecognized_keys",
        )
          ? "disallowed_field"
          : candidate.error.issues.some((issue) => issue.path[0] === "path")
            ? "bad_path"
            : "bad_field",
      );
      continue;
    }
    const proposal = candidate.data;
    if (!validPath) {
      dropped.push("bad_path");
      continue;
    }
    if (duplicatePath) {
      dropped.push("duplicate_path");
      continue;
    }
    const fieldCode = validateProposalFields(proposal, kind, limits);
    if (fieldCode) {
      dropped.push(fieldCode);
      continue;
    }
    proposals.push(proposal);
  }
  return { ok: true, report, proposals, dropped };
}

function validateProposalFields(
  proposal: SamBoxProposal,
  kind: SamBoxKind,
  limits: SamBoxOutputLimits,
): SamBoxDropCode | null {
  const kindLimits = SAM_BOX_KIND_LIMITS[kind];
  let hasFix = false;
  for (const field of FIX_FIELDS) {
    const value = proposal[field];
    if (value === undefined) continue;
    if (
      !kindLimits.allowedFields.includes(field) ||
      !limits.allowed_fields.includes(field)
    ) {
      return "disallowed_field";
    }
    if (/[<>\n\r]/.test(value)) return "markup";
    const trimmed = value.trim();
    if (!trimmed) return "bad_field";
    const max =
      field === "title"
        ? kindLimits.titleMax
        : field === "description"
          ? kindLimits.descriptionMax
          : 120;
    if (trimmed.length > max) return "too_long";
    proposal[field] = trimmed;
    hasFix = true;
  }
  if (
    [
      proposal.before_title,
      proposal.before_description,
      proposal.rationale,
    ].some((value) => value !== undefined && value.length > 300) ||
    (proposal.human_review?.length ?? 0) > 5 ||
    proposal.human_review?.some((value) => value.length > 200)
  )
    return "too_long";
  return hasFix ? null : "no_fix";
}
