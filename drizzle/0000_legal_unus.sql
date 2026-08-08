CREATE TABLE "alert_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"filters" text DEFAULT '{}' NOT NULL,
	"token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_sent_at" timestamp with time zone,
	CONSTRAINT "alert_subscriptions_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "job_sightings" (
	"id" text PRIMARY KEY NOT NULL,
	"source_key" text NOT NULL,
	"title" text NOT NULL,
	"hospital" text NOT NULL,
	"state" text DEFAULT 'Multi-state' NOT NULL,
	"specialty" text DEFAULT 'General Residency' NOT NULL,
	"employer_url" text DEFAULT '' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "alert_subscriptions_status_idx" ON "alert_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "alert_subscriptions_token_idx" ON "alert_subscriptions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "job_sightings_first_seen_idx" ON "job_sightings" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "job_sightings_last_seen_idx" ON "job_sightings" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "job_sightings_source_open_idx" ON "job_sightings" USING btree ("source_key","closed_at");