CREATE TABLE "recorded_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"tvdb_id" integer,
	"season" integer,
	"episode" integer,
	"normalized_title" text,
	"end_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "recorded" ADD COLUMN "raw_filename" text;--> statement-breakpoint
ALTER TABLE "recorded" ADD COLUMN "encode_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recorded" ADD COLUMN "encode_ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recorded" ADD COLUMN "encode_error" text;--> statement-breakpoint
ALTER TABLE "reserves" ADD COLUMN "original_start_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reserves" ADD COLUMN "original_end_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reserves" ADD COLUMN "extended_by_sec" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reserves" ADD COLUMN "allocated_tuner_idx" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "recorded_history_tvdb_uniq" ON "recorded_history" USING btree ("tvdb_id","season","episode") WHERE "recorded_history"."tvdb_id" IS NOT NULL;