CREATE TABLE `agency_ops_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`domain` text,
	`date` text NOT NULL,
	`content_type` text NOT NULL,
	`content` text NOT NULL,
	`source_key` text NOT NULL,
	`received_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agency_ops_artifacts_kind_source_key_idx` ON `agency_ops_artifacts` (`kind`,`source_key`);