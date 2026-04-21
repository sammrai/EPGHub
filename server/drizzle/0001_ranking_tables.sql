CREATE TABLE "rankings" (
	"genre_id" varchar(8) NOT NULL,
	"rank" integer NOT NULL,
	"title" text NOT NULL,
	"channel_name" text,
	"delta" integer,
	"quote" text,
	"jcom_data" jsonb NOT NULL,
	"tvdb_id" integer,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rankings_genre_id_rank_pk" PRIMARY KEY("genre_id","rank")
);
--> statement-breakpoint
ALTER TABLE "rankings" ADD CONSTRAINT "rankings_tvdb_id_tvdb_entries_tvdb_id_fk" FOREIGN KEY ("tvdb_id") REFERENCES "public"."tvdb_entries"("tvdb_id") ON DELETE set null ON UPDATE no action;