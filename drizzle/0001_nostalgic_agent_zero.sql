CREATE TABLE `alert_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`filters` text DEFAULT '{}' NOT NULL,
	`token` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`confirmed_at` text,
	`last_sent_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_subscriptions_email_unique` ON `alert_subscriptions` (`email`);--> statement-breakpoint
CREATE INDEX `alert_subscriptions_status_idx` ON `alert_subscriptions` (`status`);--> statement-breakpoint
CREATE INDEX `alert_subscriptions_token_idx` ON `alert_subscriptions` (`token`);