CREATE TABLE "auction_recoveries" (
	"auction_id" uuid PRIMARY KEY,
	"reason" text NOT NULL,
	"evidence" text NOT NULL,
	"evidence_hash" text NOT NULL,
	"detected_at" timestamp NOT NULL,
	"target_at" timestamp NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp NOT NULL,
	"last_error" text,
	"released_cents" bigint DEFAULT 0 NOT NULL,
	"captured_cents" bigint DEFAULT 0 NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "auction_recoveries_pending_idx" ON "auction_recoveries" ("state","next_attempt_at");--> statement-breakpoint
ALTER TABLE "auction_recoveries" ADD CONSTRAINT "auction_recoveries_auction_id_auctions_id_fkey" FOREIGN KEY ("auction_id") REFERENCES "auctions"("id");
--> statement-breakpoint
ALTER TABLE "auction_recoveries" ADD CONSTRAINT "auction_recoveries_state_check"
CHECK (state IN ('PENDING', 'RELEASED', 'COMPENSATION_REQUIRED') AND released_cents >= 0 AND captured_cents >= 0 AND attempts >= 0);
--> statement-breakpoint
CREATE FUNCTION preserve_recovery_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.auction_id, NEW.reason, NEW.evidence, NEW.evidence_hash, NEW.detected_at, NEW.target_at)
    IS DISTINCT FROM (OLD.auction_id, OLD.reason, OLD.evidence, OLD.evidence_hash, OLD.detected_at, OLD.target_at) THEN
    RAISE EXCEPTION 'Recovery detection evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER preserve_recovery_evidence BEFORE UPDATE ON auction_recoveries
FOR EACH ROW EXECUTE FUNCTION preserve_recovery_evidence();
