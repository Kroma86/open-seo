import type { SamLoopRepository } from "../repositories/SamLoopRepository";

export type SamBoxKind = "on_page_priorities" | "ctr_opportunities";
export const SAM_BOX_KINDS: readonly SamBoxKind[] = [
  "on_page_priorities",
  "ctr_opportunities",
];

/** One row of SamLoopRepository.getDueLoopsWithOrganization. */
export type SamBoxLoop = Awaited<
  ReturnType<typeof SamLoopRepository.getDueLoopsWithOrganization>
>[number];

export type SamBoxToolResultMeta = {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  derived: string | null;
  truncated: boolean;
  bytes: number;
};

export type SamBoxOutputLimits = {
  format: "json_object";
  schema_id: "sam-box-result-v1";
  max_output_bytes: number;
  max_report_chars: number;
  max_proposals: number;
  allowed_fields: string[];
};

/** Kind table of contract 4.1 / 5.2. */
export const SAM_BOX_KIND_LIMITS: Record<
  SamBoxKind,
  {
    maxProposals: number;
    allowedFields: readonly ("title" | "description" | "h1")[];
    titleMax: number;
    descriptionMax: number;
  }
> = {
  on_page_priorities: {
    maxProposals: 5,
    allowedFields: ["title", "description", "h1"],
    titleMax: 70,
    descriptionMax: 170,
  },
  ctr_opportunities: {
    maxProposals: 3,
    allowedFields: ["title", "description"],
    titleMax: 60,
    descriptionMax: 155,
  },
};

export type SamBoxPrepared =
  | {
      kind: "model";
      prompt: string;
      promptBytes: number;
      toolResults: SamBoxToolResultMeta[];
      staleNotice: string;
    }
  | {
      kind: "final";
      status: "completed" | "failed";
      error: string | null;
      report: string;
    };

export type SamBoxPrepareInput = {
  env: Env;
  loop: SamBoxLoop;
  kind: SamBoxKind;
  runId: string;
  maxPromptBytes: number;
};

/** Routes return Response.json(body, { status, headers: no-store }). */
export type SamBoxHttpResult = {
  status: number;
  body: Record<string, unknown>;
};

export const SAM_BOX_COST_PREFIX = "box:grok-sub";
export const SAM_BOX_LEASE_SECONDS = 900;
export const SAM_BOX_MAX_PROMPT_BYTES = 28000;
export const SAM_BOX_MAX_OUTPUT_BYTES = 24576;
export const SAM_BOX_MAX_REPORT_CHARS = 6000;
