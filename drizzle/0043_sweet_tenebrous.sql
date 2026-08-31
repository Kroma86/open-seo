CREATE TABLE `ai_visibility_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`brand` text NOT NULL,
	`competitors` text DEFAULT '[]' NOT NULL,
	`platforms` text DEFAULT '["chat_gpt","google"]' NOT NULL,
	`schedule_interval` text DEFAULT 'weekly' NOT NULL,
	`prompt_set_version` integer DEFAULT 1 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`last_run_at` text,
	`next_run_at` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_visibility_configs_project_brand_idx` ON `ai_visibility_configs` (`project_id`,`brand`);--> statement-breakpoint
CREATE TABLE `ai_visibility_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text NOT NULL,
	`prompt` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`config_id`) REFERENCES `ai_visibility_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_visibility_prompts_config_prompt_idx` ON `ai_visibility_prompts` (`config_id`,`prompt`);--> statement-breakpoint
CREATE TABLE `ai_visibility_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text NOT NULL,
	`project_id` text NOT NULL,
	`prompt_set_version` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`started_at` text,
	`finished_at` text,
	`total_mentions` integer,
	`share_of_voice_pct` real,
	`prompts_with_brand` integer,
	`prompts_checked` integer,
	`detail` text,
	`cost_note` text,
	`error` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`config_id`) REFERENCES `ai_visibility_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_visibility_runs_config_created_idx` ON `ai_visibility_runs` (`config_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `ai_visibility_runs_one_inflight_idx` ON `ai_visibility_runs` (`config_id`) WHERE "ai_visibility_runs"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE TABLE `sam_loop_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`loop_id` text NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`started_at` text,
	`finished_at` text,
	`report` text,
	`proposals_queued` integer DEFAULT 0 NOT NULL,
	`steps_used` integer,
	`cost_note` text,
	`error` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`loop_id`) REFERENCES `sam_loops`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sam_loop_runs_loop_created_idx` ON `sam_loop_runs` (`loop_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `sam_loop_runs_one_inflight_idx` ON `sam_loop_runs` (`loop_id`) WHERE "sam_loop_runs"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE TABLE `sam_loops` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`source_type` text NOT NULL,
	`skill_name` text,
	`custom_prompt` text,
	`cadence` text DEFAULT 'weekly' NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`last_run_at` text,
	`next_run_at` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sam_loops_project_enabled_next_idx` ON `sam_loops` (`project_id`,`is_enabled`,`next_run_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `sam_loops_project_name_idx` ON `sam_loops` (`project_id`,`name`);