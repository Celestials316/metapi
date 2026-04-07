CREATE TABLE `account_dispatch_preferences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`mode` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_dispatch_preferences_account_id_unique` ON `account_dispatch_preferences` (`account_id`);--> statement-breakpoint
CREATE INDEX `account_dispatch_preferences_mode_idx` ON `account_dispatch_preferences` (`mode`);