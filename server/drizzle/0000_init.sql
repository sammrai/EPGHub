CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"short" text NOT NULL,
	"number" text NOT NULL,
	"type" varchar(4) NOT NULL,
	"color" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" text PRIMARY KEY NOT NULL,
	"ch" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"title" text NOT NULL,
	"genre_key" varchar(16) NOT NULL,
	"ep" text,
	"series" text,
	"hd" boolean DEFAULT false NOT NULL,
	"desc" text,
	"tvdb_id" integer,
	"tvdb_matched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recorded" (
	"id" text PRIMARY KEY NOT NULL,
	"tvdb_id" integer,
	"series" text,
	"season" integer,
	"ep" integer,
	"title" text NOT NULL,
	"ep_title" text,
	"ch" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"duration" integer NOT NULL,
	"size" double precision NOT NULL,
	"quality" varchar(8) NOT NULL,
	"filename" text NOT NULL,
	"thumb" text NOT NULL,
	"new" boolean DEFAULT false NOT NULL,
	"rule_matched" text,
	"state" varchar(16) DEFAULT 'ready' NOT NULL,
	"encode_progress" double precision,
	"encode_preset" text
);
--> statement-breakpoint
CREATE TABLE "reserves" (
	"id" text PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"ch" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"title" text NOT NULL,
	"priority" varchar(8) DEFAULT 'medium' NOT NULL,
	"quality" varchar(8) DEFAULT '1080i' NOT NULL,
	"keep_raw" boolean DEFAULT false NOT NULL,
	"margin_pre" integer DEFAULT 0 NOT NULL,
	"margin_post" integer DEFAULT 30 NOT NULL,
	"source_kind" varchar(8) DEFAULT 'once' NOT NULL,
	"source_rule_id" integer,
	"source_tvdb_id" integer,
	"state" varchar(16) DEFAULT 'scheduled' NOT NULL,
	"encode_progress" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"keyword" text NOT NULL,
	"channels" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"matches" integer DEFAULT 0 NOT NULL,
	"next_match_ch" text,
	"next_match_title" text,
	"next_match_at" timestamp with time zone,
	"priority" varchar(8) DEFAULT 'medium' NOT NULL,
	"quality" varchar(8) DEFAULT '1080i' NOT NULL,
	"skip_reruns" boolean DEFAULT true NOT NULL,
	"kind" varchar(8) DEFAULT 'keyword' NOT NULL,
	"tvdb_id" integer
);
--> statement-breakpoint
CREATE TABLE "title_overrides" (
	"normalized_title" text PRIMARY KEY NOT NULL,
	"tvdb_id" integer,
	"user_set" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tvdb_entries" (
	"tvdb_id" integer PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"kind" varchar(8) NOT NULL,
	"title" text NOT NULL,
	"title_en" text NOT NULL,
	"network" text NOT NULL,
	"year" integer NOT NULL,
	"poster" text NOT NULL,
	"matched_by" text NOT NULL,
	"total_seasons" integer,
	"current_season" integer,
	"current_ep" integer,
	"total_eps" integer,
	"status" varchar(16),
	"runtime" integer,
	"director" text,
	"rating" double precision,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_ch_channels_id_fk" FOREIGN KEY ("ch") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_tvdb_id_tvdb_entries_tvdb_id_fk" FOREIGN KEY ("tvdb_id") REFERENCES "public"."tvdb_entries"("tvdb_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reserves" ADD CONSTRAINT "reserves_source_rule_id_rules_id_fk" FOREIGN KEY ("source_rule_id") REFERENCES "public"."rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_tvdb_id_tvdb_entries_tvdb_id_fk" FOREIGN KEY ("tvdb_id") REFERENCES "public"."tvdb_entries"("tvdb_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "title_overrides" ADD CONSTRAINT "title_overrides_tvdb_id_tvdb_entries_tvdb_id_fk" FOREIGN KEY ("tvdb_id") REFERENCES "public"."tvdb_entries"("tvdb_id") ON DELETE set null ON UPDATE no action;