CREATE TABLE "login_rate_limits" (
	"key" varchar(80) PRIMARY KEY,
	"attempts" integer NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "login_rate_limits_expires_at_idx" ON "login_rate_limits" ("expires_at");