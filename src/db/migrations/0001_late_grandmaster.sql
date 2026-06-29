CREATE TABLE "trip_fx_defaults" (
	"trip_id" uuid NOT NULL,
	"base_currency" text NOT NULL,
	"settlement_currency" text NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trip_fx_defaults_trip_id_base_currency_settlement_currency_pk" PRIMARY KEY("trip_id","base_currency","settlement_currency"),
	CONSTRAINT "fx_default_rate_pos" CHECK ("trip_fx_defaults"."rate" > 0)
);
--> statement-breakpoint
ALTER TABLE "trip_fx_defaults" ADD CONSTRAINT "trip_fx_defaults_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_fx_defaults" ADD CONSTRAINT "trip_fx_defaults_base_currency_currencies_code_fk" FOREIGN KEY ("base_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_fx_defaults" ADD CONSTRAINT "trip_fx_defaults_settlement_currency_currencies_code_fk" FOREIGN KEY ("settlement_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;