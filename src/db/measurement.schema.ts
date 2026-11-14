import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { projects, aiVisibilityConfigs } from "./app.schema";

export const measurementEnrollments = sqliteTable("measurement_enrollments", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  configId: text("config_id")
    .notNull()
    .references(() => aiVisibilityConfigs.id, { onDelete: "cascade" }),
  domain: text("domain").notNull(),
  contextHash: text("context_hash").notNull(),
  eligibilityEvidence: text("eligibility_evidence").notNull(),
  eligibilityHash: text("eligibility_hash").notNull(),
  verifiedAt: text("verified_at").notNull(),
  startsAt: text("starts_at").notNull(),
  dryRunAt: text("dry_run_at"),
  dryRunHash: text("dry_run_hash"),
});
export const measurementQuestions = sqliteTable(
  "measurement_questions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => measurementEnrollments.projectId, {
        onDelete: "cascade",
      }),
    promptId: text("prompt_id").notNull(),
    prompt: text("prompt").notNull(),
    kind: text("kind", { enum: ["active", "approved_context"] }).notNull(),
    approvalEvidence: text("approval_evidence"),
  },
  (t) => [
    uniqueIndex("measurement_question_project_prompt_idx").on(
      t.projectId,
      t.promptId,
    ),
  ],
);
export const measurementBudgets = sqliteTable("measurement_budgets", {
  week: text("week").primaryKey(),
  answers: integer("answers").notNull().default(0),
  billedCreditHundredths: integer("billed_credit_hundredths")
    .notNull()
    .default(0),
  held: integer("held", { mode: "boolean" }).notNull().default(false),
});
export const measurementRuns = sqliteTable(
  "measurement_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, {
        onDelete: "cascade",
      }),
    week: text("week").notNull(),
    pilotStartsAt: text("pilot_starts_at").notNull(),
    brand: text("brand").notNull(),
    domain: text("domain").notNull(),
    configId: text("config_id").notNull(),
    status: text("status", {
      enum: ["reserved", "posting", "collecting", "completed", "refused"],
    }).notNull(),
    answers: integer("answers").notNull(),
    reservedBilledCreditHundredths: integer(
      "reserved_billed_credit_hundredths",
    ).notNull(),
    actualBilledCreditHundredths: integer("actual_billed_credit_hundredths")
      .notNull()
      .default(0),
    createdAt: text("created_at").notNull(),
    reason: text("reason"),
  },
  (t) => [
    uniqueIndex("measurement_run_project_week_idx").on(t.projectId, t.week),
    uniqueIndex("measurement_run_project_pilot_idx").on(
      t.projectId,
      t.pilotStartsAt,
    ),
  ],
);
export const measurementAnswers = sqliteTable(
  "measurement_answers",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => measurementRuns.id, { onDelete: "cascade" }),
    promptId: text("prompt_id").notNull(),
    prompt: text("prompt").notNull(),
    engine: text("engine", { enum: ["chatgpt", "ai_mode"] }).notNull(),
    repeat: integer("repeat").notNull(),
    taskId: text("task_id"),
    status: text("status", {
      enum: ["planned", "posted", "completed", "error", "timeout", "unparsed"],
    }).notNull(),
    named: integer("named", { mode: "boolean" }),
    cited: integer("cited", { mode: "boolean" }),
    answerText: text("answer_text"),
    channels: text("channels"),
    postedAt: text("posted_at"),
  },
  (t) => [
    uniqueIndex("measurement_answer_repeat_idx").on(
      t.runId,
      t.promptId,
      t.engine,
      t.repeat,
    ),
    uniqueIndex("measurement_answer_task_idx").on(t.taskId),
  ],
);
export const measurementCitations = sqliteTable("measurement_citations", {
  id: text("id").primaryKey(),
  answerId: text("answer_id")
    .notNull()
    .references(() => measurementAnswers.id, { onDelete: "cascade" }),
  domain: text("domain").notNull(),
});
