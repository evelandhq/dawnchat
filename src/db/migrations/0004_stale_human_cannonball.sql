ALTER TABLE "agent_connections" ADD COLUMN "eveland_project_id" text;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "owner_identity_principal_id" text;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "owner_identity_realm_id" text;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "eveland_project_id" text;