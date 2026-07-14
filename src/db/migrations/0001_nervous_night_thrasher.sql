ALTER TABLE "events" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "stream_index" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "events_chat_id_session_id_stream_index_unique" ON "events" USING btree ("chat_id","session_id","stream_index");