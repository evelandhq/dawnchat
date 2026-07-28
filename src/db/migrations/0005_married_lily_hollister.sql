DROP INDEX "agent_connections_base_url_unique";--> statement-breakpoint
ALTER TABLE "agent_connections" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD COLUMN "source" text DEFAULT 'external' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD COLUMN "identity_issuer" text;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD COLUMN "catalog_last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "owner_identity_issuer" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_connections_external_base_url_unique" ON "agent_connections" USING btree ("base_url") WHERE "agent_connections"."source" = 'external';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_connections_managed_identity_unique" ON "agent_connections" USING btree ("identity_issuer","eveland_project_id") WHERE "agent_connections"."source" = 'managed';