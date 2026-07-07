CREATE TABLE "user_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"consent_type" text NOT NULL,
	"document_version" text NOT NULL,
	"source" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	CONSTRAINT "consent_type_check" CHECK ("user_consents"."consent_type" IN ('tos','privacy','llm_disclosure')),
	CONSTRAINT "consent_source_check" CHECK ("user_consents"."source" IN ('signup','invite_accept','usage_parse','settings'))
);
--> statement-breakpoint
ALTER TABLE "user_consents" ADD CONSTRAINT "user_consents_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_consent" ON "user_consents" USING btree ("user_id","consent_type","document_version");