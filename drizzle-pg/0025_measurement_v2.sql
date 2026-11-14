CREATE TABLE "measurement_answers" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"prompt_id" text NOT NULL,
	"prompt" text NOT NULL,
	"engine" text NOT NULL,
	"repeat" integer NOT NULL,
	"task_id" text,
	"status" text NOT NULL,
	"named" boolean,
	"cited" boolean,
	"answer_text" text,
	"channels" text,
	"posted_at" text
);
--> statement-breakpoint
CREATE TABLE "measurement_budgets" (
	"week" text PRIMARY KEY NOT NULL,
	"answers" integer DEFAULT 0 NOT NULL,
	"billed_credit_hundredths" integer DEFAULT 0 NOT NULL,
	"held" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "measurement_citations" (
	"id" text PRIMARY KEY NOT NULL,
	"answer_id" text NOT NULL,
	"domain" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "measurement_enrollments" (
	"project_id" text PRIMARY KEY NOT NULL,
	"config_id" text NOT NULL,
	"domain" text NOT NULL,
	"context_hash" text NOT NULL,
	"eligibility_evidence" text NOT NULL,
	"eligibility_hash" text NOT NULL,
	"verified_at" text NOT NULL,
	"starts_at" text NOT NULL,
	"dry_run_at" text,
	"dry_run_hash" text
);
--> statement-breakpoint
CREATE TABLE "measurement_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"prompt_id" text NOT NULL,
	"prompt" text NOT NULL,
	"kind" text NOT NULL,
	"approval_evidence" text
);
--> statement-breakpoint
CREATE TABLE "measurement_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"week" text NOT NULL,
	"pilot_starts_at" text NOT NULL,
	"brand" text NOT NULL,
	"domain" text NOT NULL,
	"config_id" text NOT NULL,
	"status" text NOT NULL,
	"answers" integer NOT NULL,
	"reserved_billed_credit_hundredths" integer NOT NULL,
	"actual_billed_credit_hundredths" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"reason" text
);
--> statement-breakpoint
ALTER TABLE "measurement_answers" ADD CONSTRAINT "measurement_answers_run_id_measurement_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."measurement_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurement_citations" ADD CONSTRAINT "measurement_citations_answer_id_measurement_answers_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."measurement_answers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurement_enrollments" ADD CONSTRAINT "measurement_enrollments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurement_enrollments" ADD CONSTRAINT "measurement_enrollments_config_id_ai_visibility_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."ai_visibility_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurement_questions" ADD CONSTRAINT "measurement_questions_project_id_measurement_enrollments_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."measurement_enrollments"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurement_runs" ADD CONSTRAINT "measurement_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "measurement_answer_repeat_idx" ON "measurement_answers" USING btree ("run_id","prompt_id","engine","repeat");--> statement-breakpoint
CREATE UNIQUE INDEX "measurement_answer_task_idx" ON "measurement_answers" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "measurement_question_project_prompt_idx" ON "measurement_questions" USING btree ("project_id","prompt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "measurement_run_project_week_idx" ON "measurement_runs" USING btree ("project_id","week");--> statement-breakpoint
CREATE UNIQUE INDEX "measurement_run_project_pilot_idx" ON "measurement_runs" USING btree ("project_id","pilot_starts_at");