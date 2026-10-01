import {
  stripDraftEvidence,
  validateMonthlyContent,
} from "./monthlyContentResult";

export async function validateSamLoopOutput(
  result: {
    text?: string;
    finishReason?: string;
    output?: unknown;
    steps: Array<{
      toolResults?: Array<{ toolName: string; output?: unknown }>;
    }>;
  },
  monthly: boolean,
  domain: string,
): Promise<{ report: string; error: string | null }> {
  let report = stripDraftEvidence(result.text ?? "");
  let error: string | null = null;
  if (result.finishReason && result.finishReason !== "stop") {
    error = `The model did not finish normally (${result.finishReason}); the report is incomplete.`;
  } else if (monthly) {
    try {
      const article = await validateMonthlyContent(
        result.output,
        result.steps,
        domain,
      );
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
  return { report, error };
}
