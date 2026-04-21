CREATE TABLE "drop_logs" (
	"recorded_id" text PRIMARY KEY NOT NULL,
	"error_cnt" integer DEFAULT 0 NOT NULL,
	"drop_cnt" integer DEFAULT 0 NOT NULL,
	"scrambling_cnt" integer DEFAULT 0 NOT NULL,
	"per_pid" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recorded" ADD COLUMN "thumb_generated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "recorded" ADD COLUMN "protected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reserves" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "ng_keywords" jsonb;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "genre_deny" jsonb;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "time_range_deny" jsonb;--> statement-breakpoint
ALTER TABLE "drop_logs" ADD CONSTRAINT "drop_logs_recorded_id_recorded_id_fk" FOREIGN KEY ("recorded_id") REFERENCES "public"."recorded"("id") ON DELETE cascade ON UPDATE no action;