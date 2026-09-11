/**
 * Typed classification for headless SAM loop model failures.
 *
 * The run row stores only the human-readable error string; this is the
 * machine-readable companion. SamLoopWorkflow logs it as a structured
 * `sam_loop_run_failed` event so a later internal alert can key on `kind`
 * without parsing prose. Persisting `kind` onto the run row is a deliberate
 * non-goal here — that would be a schema change, and this patch carries none.
 */
export const SAM_LOOP_MODEL_FAILURE_KINDS = [
  // generateText threw: provider/routing error or structured-output rejection.
  "generation_error",
  // The model did not finish with "stop" (length, tool-calls, error,
  // content-filter, other) or returned no finish reason at all.
  "incomplete_finish",
  // finishReason "stop" but no usable report text.
  "empty_report",
  // Monthly structured article output failed validation.
  "invalid_monthly_content",
] as const;

export type SamLoopModelFailureKind =
  (typeof SAM_LOOP_MODEL_FAILURE_KINDS)[number];

export type SamLoopModelFailure = {
  kind: SamLoopModelFailureKind;
  /**
   * Machine detail for alerting: a finish reason or a safe error type.
   * Raw provider messages are deliberately excluded because they can echo
   * prompts, provider response bodies, or sensitive request context.
   */
  detail: string | null;
};

const DETAIL_CAP = 300;

export function samLoopModelFailure(
  kind: SamLoopModelFailureKind,
  detail?: string | null,
): SamLoopModelFailure {
  const trimmed = detail?.trim();
  return { kind, detail: trimmed ? trimmed.slice(0, DETAIL_CAP) : null };
}

/** A safe error-type marker for internal alerts; never expose the raw message. */
export function describeThrown(error: unknown): string {
  const name = error instanceof Error && error.name.trim()
    ? error.name.trim().slice(0, DETAIL_CAP)
    : "NonErrorThrow";
  return `${name} (message redacted)`;
}
