ALTER TABLE "audit_anchors" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "audit_anchors" ADD COLUMN "blocked_at" timestamp;