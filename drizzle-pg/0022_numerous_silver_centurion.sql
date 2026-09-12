CREATE TABLE "agency_ops_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"domain" text,
	"date" text NOT NULL,
	"content_type" text NOT NULL,
	"content" text NOT NULL,
	"source_key" text NOT NULL,
	"received_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agency_ops_artifacts_kind_source_key_idx" ON "agency_ops_artifacts" USING btree ("kind","source_key");