import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { projects } from "./app.schema";

// Agency-platform tables (Sam loops, tracked AI visibility, ops artifacts),
// split out of app.schema.ts to keep that file under the max-lines lint limit.
// Purely a file move: the tables are unchanged and are still exported through
// the d1/pg schema barrels and the provider-aware "@/db/schema".

// ============================================================================
// Sam Loops tables — scheduled playbook runs per project (P3, sa-gauntlet).
// A loop = (Sam skill | custom prompt) + cadence + project. The executor runs
// Sam headlessly; the only write path out of a run is the HomeGrown OTTO
// proposal queue — applying stays with the tier-aware gate chain.
// ============================================================================

export const samLoops = sqliteTable(
  "sam_loops",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sourceType: text("source_type", { enum: ["skill", "custom"] }).notNull(),
    // Skill folder name under .agents/skills/ when sourceType = "skill".
    skillName: text("skill_name"),
    // Full prompt text when sourceType = "custom".
    customPrompt: text("custom_prompt"),
    cadence: text("cadence", { enum: ["daily", "weekly", "monthly"] })
      .notNull()
      .default("weekly"),
    isEnabled: integer("is_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    lastRunAt: text("last_run_at"),
    nextRunAt: text("next_run_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
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

// One row per loop execution. The partial unique index on
// `loop_id WHERE status IN ('pending','running')` enforces at most one
// in-flight run per loop at the DB level (same duplicate-trigger protection
// as rank_check_runs).
export const samLoopRuns = sqliteTable(
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
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    // Plain-English run report written by Sam at the end of the run.
    report: text("report"),
    proposalsQueued: integer("proposals_queued").notNull().default(0),
    stepsUsed: integer("steps_used"),
    // Human-readable spend note ("cache hit", "$0.02 DataForSEO"), never a lie.
    costNote: text("cost_note"),
    error: text("error"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("sam_loop_runs_loop_created_idx").on(table.loopId, table.createdAt),
    uniqueIndex("sam_loop_runs_one_inflight_idx")
      .on(table.loopId)
      .where(sql`${table.status} IN ('pending', 'running')`),
  ],
);

// ============================================================================
// Tracked AI visibility (P2b, sa-gauntlet) — a project keeps a prompt/brand
// set and re-checks it on a schedule; deltas only between real runs of the
// same prompt-set version. Mirrors the rank-tracking table conventions.
// ============================================================================

export const aiVisibilityConfigs = sqliteTable(
  "ai_visibility_configs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    brand: text("brand").notNull(),
    // JSON array of competitor names (string[]), stored as text.
    competitors: text("competitors").notNull().default("[]"),
    // JSON array of LlmPlatform ids, stored as text.
    platforms: text("platforms").notNull().default('["chat_gpt","google"]'),
    scheduleInterval: text("schedule_interval", {
      enum: ["weekly", "monthly", "manual"],
    })
      .notNull()
      .default("weekly"),
    // Bumped whenever the prompt set changes — a new version starts a new
    // baseline; deltas never span versions.
    promptSetVersion: integer("prompt_set_version").notNull().default(1),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    lastRunAt: text("last_run_at"),
    nextRunAt: text("next_run_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("ai_visibility_configs_project_brand_idx").on(
      table.projectId,
      table.brand,
    ),
  ],
);

export const aiVisibilityPrompts = sqliteTable(
  "ai_visibility_prompts",
  {
    id: text("id").primaryKey(),
    configId: text("config_id")
      .notNull()
      .references(() => aiVisibilityConfigs.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("ai_visibility_prompts_config_prompt_idx").on(
      table.configId,
      table.prompt,
    ),
  ],
);

// One row per scheduled/manual check. Numbers come from the ai-search
// services or stay null — never invented, never zero-filled.
export const aiVisibilityRuns = sqliteTable(
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
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    totalMentions: integer("total_mentions"),
    shareOfVoicePct: real("share_of_voice_pct"),
    promptsWithBrand: integer("prompts_with_brand"),
    promptsChecked: integer("prompts_checked"),
    // JSON blob of per-platform outcome + citations snapshot.
    detail: text("detail"),
    costNote: text("cost_note"),
    error: text("error"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
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

// Hermes ops box artifacts (alert cycles, monthly reports, digests) pushed
// from the agency ops box via the internal ingest endpoint.
export const agencyOpsArtifacts = sqliteTable(
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
    receivedAt: text("received_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("agency_ops_artifacts_kind_source_key_idx").on(
      table.kind,
      table.sourceKey,
    ),
  ],
);
