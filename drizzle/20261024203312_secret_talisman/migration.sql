CREATE TABLE "bid_operations" (
	"id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"auction_id" uuid NOT NULL,
	"key" varchar(128) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"bid_id" uuid NOT NULL UNIQUE,
	"result" json NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_reservations_active_auction_unique" ON "wallet_reservations" ("auction_id") WHERE "status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "bid_operations_user_auction_key_unique" ON "bid_operations" ("user_id","auction_id","key");--> statement-breakpoint
ALTER TABLE "bid_operations" ADD CONSTRAINT "bid_operations_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "bid_operations" ADD CONSTRAINT "bid_operations_auction_id_auctions_id_fkey" FOREIGN KEY ("auction_id") REFERENCES "auctions"("id");--> statement-breakpoint
ALTER TABLE "bid_operations" ADD CONSTRAINT "bid_operations_bid_id_bids_id_fkey" FOREIGN KEY ("bid_id") REFERENCES "bids"("id");