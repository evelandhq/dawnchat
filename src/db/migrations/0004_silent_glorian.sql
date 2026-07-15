CREATE TABLE "agent_credentials" (
	"agent_connection_id" text NOT NULL,
	"security_revision" integer NOT NULL,
	"credential_scope" text NOT NULL,
	"scope_subject" text NOT NULL,
	"auth_method" text NOT NULL,
	"credential_key" text DEFAULT '' NOT NULL,
	"payload_encrypted" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"refresh_owner" text,
	"refresh_lease_id" text,
	"refresh_lease_until" timestamp with time zone,
	"rotation_seq" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_credentials_credential_scope_valid" CHECK ("agent_credentials"."credential_scope" in ('connection', 'principal')),
	CONSTRAINT "agent_credentials_scope_subject_valid" CHECK (("agent_credentials"."credential_scope" = 'connection' and "agent_credentials"."scope_subject" = '') or ("agent_credentials"."credential_scope" = 'principal' and "agent_credentials"."scope_subject" <> '')),
	CONSTRAINT "agent_credentials_security_revision_positive" CHECK ("agent_credentials"."security_revision" > 0),
	CONSTRAINT "agent_credentials_rotation_seq_nonnegative" CHECK ("agent_credentials"."rotation_seq" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_connections" ADD COLUMN "security_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_agent_connection_id_agent_connections_id_fk" FOREIGN KEY ("agent_connection_id") REFERENCES "public"."agent_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_credentials_identity_unique" ON "agent_credentials" USING btree ("agent_connection_id","security_revision","auth_method","credential_scope","scope_subject","credential_key");--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_security_revision_positive" CHECK ("agent_connections"."security_revision" > 0);