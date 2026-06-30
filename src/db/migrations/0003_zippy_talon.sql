CREATE TABLE "idempotency_keys" (
	"scope_key" text PRIMARY KEY NOT NULL,
	"request_hash" text NOT NULL,
	"status" integer,
	"response_body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ix_idempotency_expires" ON "idempotency_keys" USING btree ("expires_at");