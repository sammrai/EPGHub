ALTER TABLE "programs" ADD COLUMN "tvdb_season" integer;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "tvdb_episode" integer;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "tvdb_episode_name" text;--> statement-breakpoint
ALTER TABLE "tvdb_entries" ADD COLUMN "episodes" jsonb;