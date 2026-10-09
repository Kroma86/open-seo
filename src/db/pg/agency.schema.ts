import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  real,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./app.schema";

// Agency-platform tables (Sam loops, tracked AI visibility, ops artifacts),
// split out of app.schema.ts to keep that file under the max-lines lint limit.
// See src/db/pg/app.schema.ts for why timestamps are ISO-8601 UTC text.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const timestampColumn = (name: string) => text(name);

// ============================================================================
// Sam Loops — scheduled skill/prompt runs through headless Sam
// ============================================================================

export const samLoops = pgTable(
  "sam_loops",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sourceType: text("source_type", { enum: ["skill", "custom"] }).notNull(),
    skillName: text("skill_name"),
    customPrompt: text("custom_prompt"),
    cadence: text("cadence", { enum: ["daily", "weekly", "monthly"] })
      .notNull()
      .default("weekly"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    lastRunAt: timestampColumn("last_run_at"),
    nextRunAt: timestampColumn("next_run_at"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    index("sam_loops_project_enabled_next_idx").on(
      table.projectId,
      table.isEnabled,
      table.nextRunAt,
    ),
    uniqueIndex("sam_loops_project_name_idx").on(table.projectId, table.name),
  ],
);

export const samLoopRuns = pgTable(
  "sam_loop_runs",
  {
    id: text("id").primaryKey(),
    loopId: text("loop_id")
      .notNull()
      .references(() => samLoops.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["pending", "running", "completed", "failed"],
    })
      .notNull()
      .default("pending"),
    startedAt: timestampColumn("started_at"),
    finishedAt: timestampColumn("finished_at"),
    report: text("report"),
    proposalsQueued: integer("proposals_queued").notNull().default(0),
    stepsUsed: integer("steps_used"),
    costNote: text("cost_note"),
    error: text("error"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    index("sam_loop_runs_loop_created_idx").on(table.loopId, table.createdAt),
    uniqueIndex("sam_loop_runs_one_inflight_idx")
      .on(table.loopId)
      .where(sql`${table.status} IN ('pending', 'running')`),
  ],
);

// ============================================================================
// Tracked AI visibility (P2b) — mirror SQLite for schema-parity
// ============================================================================

export const aiVisibilityConfigs = pgTable(
  "ai_visibility_configs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    brand: text("brand").notNull(),
    competitors: text("competitors").notNull().default("[]"),
    platforms: text("platforms").notNull().default('["chat_gpt","google"]'),
    scheduleInterval: text("schedule_interval", {
      enum: ["weekly", "monthly", "manual"],
    })
      .notNull()
      .default("weekly"),
    promptSetVersion: integer("prompt_set_version").notNull().default(1),
    isActive: boolean("is_active").notNull().default(true),
    lastRunAt: timestampColumn("last_run_at"),
    nextRunAt: timestampColumn("next_run_at"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("ai_visibility_configs_project_brand_idx").on(
      table.projectId,
      table.brand,
    ),
  ],
);

export const aiVisibilityPrompts = pgTable(
  "ai_visibility_prompts",
  {
    id: text("id").primaryKey(),
    configId: text("config_id")
      .notNull()
      .references(() => aiVisibilityConfigs.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("ai_visibility_prompts_config_prompt_idx").on(
      table.configId,
      table.prompt,
    ),
  ],
);

export const aiVisibilityRuns = pgTable(
  "ai_visibility_runs",
  {
    id: text("id").primaryKey(),
    configId: text("config_id")
      .notNull()
      .references(() => aiVisibilityConfigs.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    promptSetVersion: integer("prompt_set_version").notNull(),
    status: text("status", {
      enum: ["pending", "running", "completed", "failed"],
    })
      .notNull()
      .default("pending"),
    startedAt: timestampColumn("started_at"),
    finishedAt: timestampColumn("finished_at"),
    totalMentions: integer("total_mentions"),
    shareOfVoicePct: real("share_of_voice_pct"),
    promptsWithBrand: integer("prompts_with_brand"),
    promptsChecked: integer("prompts_checked"),
    detail: text("detail"),
    costNote: text("cost_note"),
    error: text("error"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    index("ai_visibility_runs_config_created_idx").on(
      table.configId,
      table.createdAt,
    ),
    uniqueIndex("ai_visibility_runs_one_inflight_idx")
      .on(table.configId)
      .where(sql`${table.status} IN ('pending', 'running')`),
  ],
);

export const agencyOpsArtifacts = pgTable(
  "agency_ops_artifacts",
  {
    id: text("id").primaryKey(),
    kind: text("kind", {
      // Plain text column; the enum list is type-level only and mirrors the
      // shared KINDS list in src/shared/agency-ops.ts (no migration needed).
      enum: [
        "alert-cycle",
        "monthly-report",
        "monthly-export",
        "fix-changelog",
        "client-sync",
        "gbp-audit",
        "digest",
        "index-watchdog",
        "schema-proposals",
        "citations",
        "heatmap",
      ],
    }).notNull(),
    domain: text("domain"),
    date: text("date").notNull(),
    contentType: text("content_type", {
      enum: ["json", "html", "markdown"],
    }).notNull(),
    content: text("content").notNull(),
    sourceKey: text("source_key").notNull(),
    receivedAt: timestampColumn("received_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("agency_ops_artifacts_kind_source_key_idx").on(
      table.kind,
      table.sourceKey,
    ),
  ],
);
