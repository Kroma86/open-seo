CREATE TABLE "proposal_rejections" (
	"proposal_id" text PRIMARY KEY NOT NULL,
	"payload_hash" text NOT NULL,
	"domain" text NOT NULL,
	"path" text NOT NULL,
	"organization_id" text,
	"request_id" text NOT NULL,
	"reason" text NOT NULL,
	"rejected_at" text NOT NULL,
	"prior_status" text NOT NULL,
	"prior_pulled_at" text
);
