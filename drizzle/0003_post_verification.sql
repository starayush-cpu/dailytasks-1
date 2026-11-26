ALTER TABLE completions ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE completions ADD COLUMN verified_source TEXT;
--> statement-breakpoint
ALTER TABLE completions ADD COLUMN views INTEGER;
--> statement-breakpoint
ALTER TABLE completions ADD COLUMN likes INTEGER;
--> statement-breakpoint
ALTER TABLE completions ADD COLUMN reposts INTEGER;
--> statement-breakpoint
ALTER TABLE completions ADD COLUMN replies INTEGER;
