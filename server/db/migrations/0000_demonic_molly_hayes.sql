CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"room_limit" bigint,
	"sort_order" integer NOT NULL,
	CONSTRAINT "account_label_present" CHECK (btrim("accounts"."label") <> ''),
	CONSTRAINT "room_limit_non_negative" CHECK ("accounts"."room_limit" IS NULL OR "accounts"."room_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"sleeve_id" text NOT NULL,
	"ticker" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"weight_bps" integer NOT NULL,
	"holding_cents" bigint DEFAULT 0 NOT NULL,
	"sort_order" integer NOT NULL,
	CONSTRAINT "asset_ticker_unique_in_sleeve" UNIQUE("sleeve_id","ticker"),
	CONSTRAINT "asset_ticker_present" CHECK (btrim("assets"."ticker") <> ''),
	CONSTRAINT "weight_bps_valid" CHECK ("assets"."weight_bps" BETWEEN 0 AND 10000),
	CONSTRAINT "holding_non_negative" CHECK ("assets"."holding_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "investment_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"investment_id" integer NOT NULL,
	"asset_id" text NOT NULL,
	"intended_cents" bigint NOT NULL,
	"amount_cents" bigint NOT NULL,
	CONSTRAINT "investment_lines_investment_id_asset_id_key" UNIQUE("investment_id","asset_id"),
	CONSTRAINT "amounts_non_negative" CHECK ("investment_lines"."amount_cents" >= 0 AND "investment_lines"."intended_cents" >= "investment_lines"."amount_cents")
);
--> statement-breakpoint
CREATE TABLE "investments" (
	"id" serial PRIMARY KEY NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"requested_cents" bigint NOT NULL,
	"allocated_cents" bigint NOT NULL,
	"unallocated_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requested_positive" CHECK ("investments"."requested_cents" > 0),
	CONSTRAINT "allocation_balances" CHECK ("investments"."allocated_cents" + "investments"."unallocated_cents" = "investments"."requested_cents")
);
--> statement-breakpoint
CREATE TABLE "sleeves" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"label" text NOT NULL,
	"target_bps" integer NOT NULL,
	"sort_order" integer NOT NULL,
	CONSTRAINT "sleeve_label_present" CHECK (btrim("sleeves"."label") <> ''),
	CONSTRAINT "target_bps_valid" CHECK ("sleeves"."target_bps" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_sleeve_id_sleeves_id_fk" FOREIGN KEY ("sleeve_id") REFERENCES "public"."sleeves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_lines" ADD CONSTRAINT "investment_lines_investment_id_investments_id_fk" FOREIGN KEY ("investment_id") REFERENCES "public"."investments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_lines" ADD CONSTRAINT "investment_lines_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sleeves" ADD CONSTRAINT "sleeves_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_sleeve_idx" ON "assets" USING btree ("sleeve_id");--> statement-breakpoint
CREATE INDEX "investment_lines_investment_idx" ON "investment_lines" USING btree ("investment_id");--> statement-breakpoint
CREATE INDEX "investment_lines_asset_idx" ON "investment_lines" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "sleeves_account_idx" ON "sleeves" USING btree ("account_id");