CREATE TABLE "expense_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"source" text DEFAULT 'text' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"confirm_payload" jsonb,
	"confirmed_expense_id" uuid,
	"source_object_key" text,
	"import_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "draft_source_check" CHECK ("expense_drafts"."source" IN ('text','image')),
	CONSTRAINT "draft_status_check" CHECK ("expense_drafts"."status" IN ('pending','confirmed','discarded'))
);
--> statement-breakpoint
ALTER TABLE "expense_drafts" ADD CONSTRAINT "expense_drafts_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_draft_trip_status" ON "expense_drafts" USING btree ("trip_id","status");