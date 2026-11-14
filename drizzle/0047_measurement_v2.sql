CREATE TABLE `measurement_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`prompt_id` text NOT NULL,
	`prompt` text NOT NULL,
	`engine` text NOT NULL,
	`repeat` integer NOT NULL,
	`task_id` text,
	`status` text NOT NULL,
	`named` integer,
	`cited` integer,
	`answer_text` text,
	`channels` text,
	`posted_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `measurement_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `measurement_answer_repeat_idx` ON `measurement_answers` (`run_id`,`prompt_id`,`engine`,`repeat`);--> statement-breakpoint
CREATE UNIQUE INDEX `measurement_answer_task_idx` ON `measurement_answers` (`task_id`);--> statement-breakpoint
CREATE TABLE `measurement_budgets` (
	`week` text PRIMARY KEY NOT NULL,
	`answers` integer DEFAULT 0 NOT NULL,
	`billed_credit_hundredths` integer DEFAULT 0 NOT NULL,
	`held` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `measurement_citations` (
	`id` text PRIMARY KEY NOT NULL,
	`answer_id` text NOT NULL,
	`domain` text NOT NULL,
	FOREIGN KEY (`answer_id`) REFERENCES `measurement_answers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `measurement_enrollments` (
	`project_id` text PRIMARY KEY NOT NULL,
	`config_id` text NOT NULL,
	`domain` text NOT NULL,
	`context_hash` text NOT NULL,
	`eligibility_evidence` text NOT NULL,
	`eligibility_hash` text NOT NULL,
	`verified_at` text NOT NULL,
	`starts_at` text NOT NULL,
	`dry_run_at` text,
	`dry_run_hash` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`config_id`) REFERENCES `ai_visibility_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `measurement_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`prompt_id` text NOT NULL,
	`prompt` text NOT NULL,
	`kind` text NOT NULL,
	`approval_evidence` text,
	FOREIGN KEY (`project_id`) REFERENCES `measurement_enrollments`(`project_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `measurement_question_project_prompt_idx` ON `measurement_questions` (`project_id`,`prompt_id`);--> statement-breakpoint
CREATE TABLE `measurement_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`week` text NOT NULL,
	`pilot_starts_at` text NOT NULL,
	`brand` text NOT NULL,
	`domain` text NOT NULL,
	`config_id` text NOT NULL,
	`status` text NOT NULL,
	`answers` integer NOT NULL,
	`reserved_billed_credit_hundredths` integer NOT NULL,
	`actual_billed_credit_hundredths` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`reason` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `measurement_run_project_week_idx` ON `measurement_runs` (`project_id`,`week`);--> statement-breakpoint
CREATE UNIQUE INDEX `measurement_run_project_pilot_idx` ON `measurement_runs` (`project_id`,`pilot_starts_at`);