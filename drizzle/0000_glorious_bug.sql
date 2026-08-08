CREATE TABLE `job_sightings` (
	`id` text PRIMARY KEY NOT NULL,
	`source_key` text NOT NULL,
	`title` text NOT NULL,
	`hospital` text NOT NULL,
	`state` text DEFAULT 'Multi-state' NOT NULL,
	`specialty` text DEFAULT 'General Residency' NOT NULL,
	`employer_url` text DEFAULT '' NOT NULL,
	`first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`closed_at` text
);
--> statement-breakpoint
CREATE INDEX `job_sightings_first_seen_idx` ON `job_sightings` (`first_seen_at`);--> statement-breakpoint
CREATE INDEX `job_sightings_last_seen_idx` ON `job_sightings` (`last_seen_at`);