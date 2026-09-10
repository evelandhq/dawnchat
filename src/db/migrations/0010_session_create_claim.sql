ALTER TABLE "chats" ADD COLUMN "session_create_unconfirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "session_create_claim_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "session_create_claim_token" text;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "session_ended_at" timestamp with time zone;