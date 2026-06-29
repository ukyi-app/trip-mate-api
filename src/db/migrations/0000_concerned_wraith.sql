CREATE TYPE "public"."settlement_amount_source" AS ENUM('card_billed', 'converted');--> statement-breakpoint
CREATE TYPE "public"."basis" AS ENUM('settlement', 'local');--> statement-breakpoint
CREATE TYPE "public"."expense_settlement_state" AS ENUM('included', 'personal', 'record_only');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('invited', 'joined', 'deactivated', 'invite_expired');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'paid');--> statement-breakpoint
CREATE TYPE "public"."exchange_rate_source" AS ENUM('identity', 'manual', 'auto', 'last_known', 'trip_default');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."settlement_status" AS ENUM('open', 'finalized');--> statement-breakpoint
CREATE TYPE "public"."snapshot_status" AS ENUM('active', 'superseded');--> statement-breakpoint
CREATE TABLE "currencies" (
	"code" text PRIMARY KEY NOT NULL,
	"iso_exponent" integer NOT NULL,
	"minor_unit" integer NOT NULL,
	"symbol" text NOT NULL,
	CONSTRAINT "currency_code_len" CHECK (length("currencies"."code") = 3)
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"destination_countries" text[] NOT NULL,
	"timezone" text NOT NULL,
	"primary_local_currency" text NOT NULL,
	"settlement_currency" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"settlement_status" "settlement_status" DEFAULT 'open' NOT NULL,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_trip_settlement_ccy" UNIQUE("id","settlement_currency"),
	CONSTRAINT "trip_dates" CHECK ("trips"."start_date" <= "trips"."end_date")
);
--> statement-breakpoint
CREATE TABLE "trip_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"user_id" text,
	"invited_email" text NOT NULL,
	"normalized_invited_email" text NOT NULL,
	"invite_token_hash" text,
	"invite_token_expires_at" timestamp with time zone,
	"display_name" text NOT NULL,
	"role" "role" DEFAULT 'member' NOT NULL,
	"status" "member_status" DEFAULT 'invited' NOT NULL,
	"joined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_member_trip_id" UNIQUE("trip_id","id")
);
--> statement-breakpoint
CREATE TABLE "expense_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"changed_by_member_id" uuid NOT NULL,
	"change_type" text NOT NULL,
	"before_value" jsonb,
	"after_value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_type_check" CHECK ("expense_audit_logs"."change_type" IN ('create','update','delete','restore'))
);
--> statement-breakpoint
CREATE TABLE "expense_participants" (
	"trip_id" uuid NOT NULL,
	"expense_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	CONSTRAINT "expense_participants_expense_id_member_id_pk" PRIMARY KEY("expense_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"title" text NOT NULL,
	"local_amount" bigint NOT NULL,
	"local_currency" text NOT NULL,
	"settlement_amount" bigint NOT NULL,
	"settlement_currency" text NOT NULL,
	"exchange_rate" numeric(20, 10),
	"exchange_rate_date" date NOT NULL,
	"exchange_rate_source" "exchange_rate_source",
	"exchange_rate_provider" text,
	"exchange_rate_table_date" date,
	"exchange_rate_fetched_at" timestamp with time zone,
	"settlement_amount_source" "settlement_amount_source" NOT NULL,
	"payment_method" text NOT NULL,
	"category" text NOT NULL,
	"input_source" text DEFAULT 'manual' NOT NULL,
	"expense_settlement_state" "expense_settlement_state" DEFAULT 'included' NOT NULL,
	"paid_by_member_id" uuid NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"last_modified_by_member_id" uuid,
	"memo" text,
	"spent_at" timestamp with time zone NOT NULL,
	"refund_of_expense_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_expense_trip_id" UNIQUE("trip_id","id"),
	CONSTRAINT "fx_by_source" CHECK (("expenses"."settlement_amount_source"='converted' AND "expenses"."exchange_rate" IS NOT NULL AND "expenses"."exchange_rate_source" IS NOT NULL) OR ("expenses"."settlement_amount_source"='card_billed' AND "expenses"."exchange_rate_source" IS NULL)),
	CONSTRAINT "payment_method_check" CHECK ("expenses"."payment_method" IN ('cash','card','transit_card','easy_pay','other')),
	CONSTRAINT "category_check" CHECK ("expenses"."category" IN ('food','cafe_snack','transport','lodging','shopping','sightseeing','convenience','other')),
	CONSTRAINT "input_source_check" CHECK ("expenses"."input_source" IN ('manual','ai_oneline','card_sms','receipt','card_capture')),
	CONSTRAINT "refund_self" CHECK ("expenses"."refund_of_expense_id" IS NULL OR "expenses"."refund_of_expense_id" <> "expenses"."id")
);
--> statement-breakpoint
CREATE TABLE "settlement_currency_totals" (
	"settlement_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"total_amount" bigint NOT NULL,
	CONSTRAINT "settlement_currency_totals_settlement_id_currency_pk" PRIMARY KEY("settlement_id","currency")
);
--> statement-breakpoint
CREATE TABLE "settlement_member_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settlement_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"basis" "basis" NOT NULL,
	"currency" text NOT NULL,
	"total_paid" bigint NOT NULL,
	"total_share" bigint NOT NULL,
	"net_amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlement_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settlement_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"basis" "basis" NOT NULL,
	"currency" text NOT NULL,
	"from_member_id" uuid NOT NULL,
	"to_member_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"payment_status" "payment_status" DEFAULT 'pending' NOT NULL,
	"paid_at" timestamp with time zone,
	"marked_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_amount_pos" CHECK ("settlement_transfers"."amount" > 0),
	CONSTRAINT "transfer_distinct" CHECK ("settlement_transfers"."from_member_id" <> "settlement_transfers"."to_member_id"),
	CONSTRAINT "paid_consistency" CHECK ((payment_status='paid' AND paid_at IS NOT NULL AND marked_by_member_id IS NOT NULL) OR (payment_status='pending' AND paid_at IS NULL AND marked_by_member_id IS NULL)),
	CONSTRAINT "local_not_tracked" CHECK ("settlement_transfers"."basis"='settlement' OR payment_status='pending')
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "snapshot_status" DEFAULT 'active' NOT NULL,
	"finalized_by_member_id" uuid NOT NULL,
	"finalized_at" timestamp with time zone NOT NULL,
	"total_settlement_amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_settlement_trip_id" UNIQUE("trip_id","id")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_primary_local_currency_currencies_code_fk" FOREIGN KEY ("primary_local_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_settlement_currency_currencies_code_fk" FOREIGN KEY ("settlement_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_audit_logs" ADD CONSTRAINT "expense_audit_logs_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_audit_logs" ADD CONSTRAINT "expense_audit_logs_trip_id_expense_id_expenses_trip_id_id_fk" FOREIGN KEY ("trip_id","expense_id") REFERENCES "public"."expenses"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_audit_logs" ADD CONSTRAINT "expense_audit_logs_trip_id_changed_by_member_id_trip_members_trip_id_id_fk" FOREIGN KEY ("trip_id","changed_by_member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_participants" ADD CONSTRAINT "expense_participants_trip_id_expense_id_expenses_trip_id_id_fk" FOREIGN KEY ("trip_id","expense_id") REFERENCES "public"."expenses"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_participants" ADD CONSTRAINT "expense_participants_trip_id_member_id_trip_members_trip_id_id_fk" FOREIGN KEY ("trip_id","member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_local_currency_currencies_code_fk" FOREIGN KEY ("local_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_trip_id_paid_by_member_id_trip_members_trip_id_id_fk" FOREIGN KEY ("trip_id","paid_by_member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_trip_id_created_by_member_id_trip_members_trip_id_id_fk" FOREIGN KEY ("trip_id","created_by_member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_trip_id_last_modified_by_member_id_trip_members_trip_id_id_fk" FOREIGN KEY ("trip_id","last_modified_by_member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_trip_id_settlement_currency_trips_id_settlement_currency_fk" FOREIGN KEY ("trip_id","settlement_currency") REFERENCES "public"."trips"("id","settlement_currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_trip_id_refund_of_expense_id_expenses_trip_id_id_fk" FOREIGN KEY ("trip_id","refund_of_expense_id") REFERENCES "public"."expenses"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_currency_totals" ADD CONSTRAINT "settlement_currency_totals_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_currency_totals" ADD CONSTRAINT "settlement_currency_totals_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_member_summaries" ADD CONSTRAINT "settlement_member_summaries_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_member_summaries" ADD CONSTRAINT "settlement_member_summaries_trip_id_settlement_id_settlements_trip_id_id_fk" FOREIGN KEY ("trip_id","settlement_id") REFERENCES "public"."settlements"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_member_summaries" ADD CONSTRAINT "settlement_member_summaries_trip_id_member_id_trip_members_trip_id_id_fk" FOREIGN KEY ("trip_id","member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_transfers" ADD CONSTRAINT "settlement_transfers_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_transfers" ADD CONSTRAINT "settlement_transfers_trip_id_settlement_id_settlements_trip_id_id_fk" FOREIGN KEY ("trip_id","settlement_id") REFERENCES "public"."settlements"("trip_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_transfers" ADD CONSTRAINT "settlement_transfers_trip_id_from_member_id_trip_members_trip_id_id_fk" FOREIGN KEY ("trip_id","from_member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_transfers" ADD CONSTRAINT "settlement_transfers_trip_id_to_member_id_trip_members_trip_id_id_fk" FOREIGN KEY ("trip_id","to_member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_transfers" ADD CONSTRAINT "settlement_transfers_trip_id_marked_by_member_id_trip_members_trip_id_id_fk" FOREIGN KEY ("trip_id","marked_by_member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_trip_id_finalized_by_member_id_trip_members_trip_id_id_fk" FOREIGN KEY ("trip_id","finalized_by_member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_account_provider" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "ix_trip_creator" ON "trips" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_member_email" ON "trip_members" USING btree ("trip_id","normalized_invited_email");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_member_user" ON "trip_members" USING btree ("trip_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_one_admin" ON "trip_members" USING btree ("trip_id") WHERE role = 'admin' AND status = 'joined';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_invite_token" ON "trip_members" USING btree ("invite_token_hash") WHERE invite_token_hash IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_member_user" ON "trip_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_audit_expense" ON "expense_audit_logs" USING btree ("expense_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_audit_trip" ON "expense_audit_logs" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "ix_part_member" ON "expense_participants" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "ix_exp_trip_spent" ON "expenses" USING btree ("trip_id","spent_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_exp_paid_by" ON "expenses" USING btree ("paid_by_member_id");--> statement-breakpoint
CREATE INDEX "ix_exp_created_by" ON "expenses" USING btree ("created_by_member_id");--> statement-breakpoint
CREATE INDEX "ix_exp_settle" ON "expenses" USING btree ("trip_id") WHERE expense_settlement_state='included' AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "ix_exp_refund" ON "expenses" USING btree ("refund_of_expense_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_summary" ON "settlement_member_summaries" USING btree ("settlement_id","member_id","basis","currency");--> statement-breakpoint
CREATE INDEX "ix_summary_settlement" ON "settlement_member_summaries" USING btree ("settlement_id");--> statement-breakpoint
CREATE INDEX "ix_summary_member" ON "settlement_member_summaries" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_transfer_pair" ON "settlement_transfers" USING btree ("settlement_id","basis","currency","from_member_id","to_member_id");--> statement-breakpoint
CREATE INDEX "ix_transfer_settlement" ON "settlement_transfers" USING btree ("settlement_id");--> statement-breakpoint
CREATE INDEX "ix_transfer_from" ON "settlement_transfers" USING btree ("from_member_id");--> statement-breakpoint
CREATE INDEX "ix_transfer_to" ON "settlement_transfers" USING btree ("to_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_settlement_active" ON "settlements" USING btree ("trip_id") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_settlement_version" ON "settlements" USING btree ("trip_id","version");--> statement-breakpoint
CREATE INDEX "ix_settlement_finalizer" ON "settlements" USING btree ("finalized_by_member_id");