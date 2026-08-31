CREATE TABLE "ai_visibility_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"brand" text NOT NULL,
	"competitors" text DEFAULT '[]' NOT NULL,
	"platforms" text DEFAULT '["chat_gpt","google"]' NOT NULL,
	"schedule_interval" text DEFAULT 'weekly' NOT NULL,
	"prompt_set_version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" text,
	"next_run_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_visibility_prompts" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text NOT NULL,
	"prompt" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_visibility_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text NOT NULL,
	"project_id" text NOT NULL,
	"prompt_set_version" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" text,
	"finished_at" text,
	"total_mentions" integer,
	"share_of_voice_pct" real,
	"prompts_with_brand" integer,
	"prompts_checked" integer,
	"detail" text,
	"cost_note" text,
	"error" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sam_loop_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"loop_id" text NOT NULL,
	"project_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" text,
	"finished_at" text,
	"report" text,
	"proposals_queued" integer DEFAULT 0 NOT NULL,
	"steps_used" integer,
	"cost_note" text,
	"error" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sam_loops" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"source_type" text NOT NULL,
	"skill_name" text,
	"custom_prompt" text,
	"cadence" text DEFAULT 'weekly' NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" text,
	"next_run_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_visibility_configs" ADD CONSTRAINT "ai_visibility_configs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_prompts" ADD CONSTRAINT "ai_visibility_prompts_config_id_ai_visibility_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."ai_visibility_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_runs" ADD CONSTRAINT "ai_visibility_runs_config_id_ai_visibility_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."ai_visibility_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_runs" ADD CONSTRAINT "ai_visibility_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sam_loop_runs" ADD CONSTRAINT "sam_loop_runs_loop_id_sam_loops_id_fk" FOREIGN KEY ("loop_id") REFERENCES "public"."sam_loops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sam_loop_runs" ADD CONSTRAINT "sam_loop_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sam_loops" ADD CONSTRAINT "sam_loops_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_visibility_configs_project_brand_idx" ON "ai_visibility_configs" USING btree ("project_id","brand");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_visibility_prompts_config_prompt_idx" ON "ai_visibility_prompts" USING btree ("config_id","prompt");--> statement-breakpoint
CREATE INDEX "ai_visibility_runs_config_created_idx" ON "ai_visibility_runs" USING btree ("config_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_visibility_runs_one_inflight_idx" ON "ai_visibility_runs" USING btree ("config_id") WHERE "ai_visibility_runs"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "sam_loop_runs_loop_created_idx" ON "sam_loop_runs" USING btree ("loop_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sam_loop_runs_one_inflight_idx" ON "sam_loop_runs" USING btree ("loop_id") WHERE "sam_loop_runs"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "sam_loops_project_enabled_next_idx" ON "sam_loops" USING btree ("project_id","is_enabled","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sam_loops_project_name_idx" ON "sam_loops" USING btree ("project_id","name");