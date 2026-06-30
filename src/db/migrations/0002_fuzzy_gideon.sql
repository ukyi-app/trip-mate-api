CREATE TABLE "settlement_transfer_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "settlement_transfer_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"transfer_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"settlement_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_event_type_check" CHECK ("settlement_transfer_events"."event_type" IN ('paid','unpaid'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_transfer_trip_settlement_id" ON "settlement_transfers" USING btree ("trip_id","settlement_id","id");--> statement-breakpoint
ALTER TABLE "settlement_transfer_events" ADD CONSTRAINT "settlement_transfer_events_trip_id_settlement_id_transfer_id_settlement_transfers_trip_id_settlement_id_id_fk" FOREIGN KEY ("trip_id","settlement_id","transfer_id") REFERENCES "public"."settlement_transfers"("trip_id","settlement_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_transfer_events" ADD CONSTRAINT "settlement_transfer_events_trip_id_actor_member_id_trip_members_trip_id_id_fk" FOREIGN KEY ("trip_id","actor_member_id") REFERENCES "public"."trip_members"("trip_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_transfer_event" ON "settlement_transfer_events" USING btree ("transfer_id","seq" DESC NULLS LAST);--> statement-breakpoint
-- 기존 paid transfer → 합성 'paid' 이벤트(멱등 NOT EXISTS). 미배포라 보통 0건이나 "기존 paid 없음" 가정을 코드로 제거(Codex pass2 #2).
INSERT INTO "settlement_transfer_events" ("transfer_id", "trip_id", "settlement_id", "event_type", "actor_member_id", "created_at")
SELECT st."id", st."trip_id", st."settlement_id", 'paid', st."marked_by_member_id", st."paid_at"
FROM "settlement_transfers" st
WHERE st."payment_status" = 'paid' AND st."marked_by_member_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "settlement_transfer_events" e WHERE e."transfer_id" = st."id" AND e."event_type" = 'paid');
