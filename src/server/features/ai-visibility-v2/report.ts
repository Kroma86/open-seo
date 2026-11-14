import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  aiVisibilityRuns,
  measurementAnswers as answers,
  measurementCitations as citations,
  measurementRuns as runs,
} from "@/db/schema";
import { extractPromptResults } from "@/server/features/ai-visibility/services/aiVisibilityPromptResults";
import { summarizeMeasurements, type Engine } from "./match";
import { weekStart } from "./policy";

export async function measurementReport(projectId: string) {
  const [latest] = await db
    .select()
    .from(runs)
    .where(eq(runs.projectId, projectId))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  if (!latest) return { status: "not_measured", run: null, engines: [] };
  const rows = await db
    .select()
    .from(answers)
    .where(eq(answers.runId, latest.id));
  const domains = await db
    .select({ answerId: citations.answerId, domain: citations.domain })
    .from(citations)
    .innerJoin(answers, eq(citations.answerId, answers.id))
    .where(eq(answers.runId, latest.id));
  const old = latest.configId
    ? await db
        .select()
        .from(aiVisibilityRuns)
        .where(
          and(
            eq(aiVisibilityRuns.projectId, projectId),
            eq(aiVisibilityRuns.configId, latest.configId),
            eq(aiVisibilityRuns.status, "completed"),
          ),
        )
        .orderBy(desc(aiVisibilityRuns.createdAt))
        .limit(50)
    : [];
  const sameWeek = old.filter(
    (r) => weekStart(new Date(r.createdAt)) === latest.week,
  );
  const engines = (["chatgpt", "ai_mode"] as Engine[]).map((engine) => {
    const summary = summarizeMeasurements(
      rows.map((r) => ({
        ...r,
        citedDomains: domains
          .filter((d) => d.answerId === r.id)
          .map((d) => d.domain),
      })),
      engine,
    );
    let agree = 0,
      disagree = 0;
    for (const q of summary.questions) {
      const snapshot = rows.find((s) => s.promptId === q.promptId);
      for (const run of sameWeek) {
        const result = extractPromptResults(run.detail, {
          runId: run.id,
          completedAt: run.finishedAt,
          promptSetVersion: run.promptSetVersion,
        }).rows.find(
          (r) =>
            r.promptId === q.promptId &&
            r.prompt === snapshot?.prompt &&
            r.model === (engine === "chatgpt" ? "chat_gpt" : "google") &&
            r.status === "success" &&
            r.brandMentioned !== null,
        );
        if (!result) continue;
        if (result.brandMentioned === q.named) agree++;
        else disagree++;
        break;
      }
    }
    return {
      ...summary,
      comparison: {
        status: agree + disagree ? "compared" : "not_measured",
        agree,
        disagree,
        compared: agree + disagree,
        note: "Different measurement methods; same stored question and UTC week only",
      },
    };
  });
  return {
    status: latest.status,
    run: latest,
    missingAnswers: Math.max(0, latest.answers - rows.length),
    engines,
  };
}
