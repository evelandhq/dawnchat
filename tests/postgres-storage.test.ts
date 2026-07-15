import { afterEach, describe, expect, it } from "vitest";

import { createDbClient } from "@/db/client";
import { createPostgresTestDbHandle, type TestDbHandle } from "@/test/db";

const handles: TestDbHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe("PostgreSQL storage", () => {
  it("configures a finite runtime connection timeout", async () => {
    const client = createDbClient("postgresql://unused:unused@127.0.0.1:1/unused");

    expect(client.$client.options.connectionTimeoutMillis).toBe(5_000);

    await client.$client.end();
  });

  it("uses a real PostgreSQL database", async () => {
    const handle = await createPostgresTestDbHandle();
    handles.push(handle);

    const result = await handle.pool.query<{ version: string }>("select version()");

    expect(result.rows[0]?.version).toContain("PostgreSQL");
  });

  it("stores agent credentials with safe defaults", async () => {
    const handle = await createPostgresTestDbHandle();
    handles.push(handle);
    await handle.pool.query(
      `INSERT INTO agent_connections (id, name, base_url, auth_type, created_at, updated_at)
       VALUES ('agent_credential_defaults', 'Credential defaults', 'https://defaults.example.com', 'none', now(), now())`,
    );

    const result = await handle.pool.query<{
      credential_key: string;
      refresh_owner: string | null;
      refresh_lease_id: string | null;
      refresh_lease_until: Date | null;
      rotation_seq: number;
    }>(
      `INSERT INTO agent_credentials (
         agent_connection_id, security_revision, credential_scope, scope_subject,
         auth_method, payload_encrypted, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING credential_key, refresh_owner, refresh_lease_id, refresh_lease_until, rotation_seq`,
      [
        "agent_credential_defaults",
        1,
        "connection",
        "",
        "oidc-client-credentials",
        "sealed-payload",
        new Date("2026-07-16T01:00:00.000Z"),
      ],
    );

    expect(result.rows[0]).toEqual({
      credential_key: "",
      refresh_owner: null,
      refresh_lease_id: null,
      refresh_lease_until: null,
      rotation_seq: 0,
    });
  });

  it("rejects duplicate agent credential composite keys", async () => {
    const handle = await createPostgresTestDbHandle();
    handles.push(handle);
    await handle.pool.query(
      `INSERT INTO agent_connections (id, name, base_url, auth_type, created_at, updated_at)
       VALUES ('agent_credential_unique', 'Credential uniqueness', 'https://unique.example.com', 'none', now(), now())`,
    );
    const insertCredential = (payload: string) =>
      handle.pool.query(
        `INSERT INTO agent_credentials (
           agent_connection_id, security_revision, credential_scope, scope_subject,
           auth_method, credential_key, payload_encrypted, expires_at
         ) VALUES (
           'agent_credential_unique', 1, 'principal', 'user_123',
           'oidc-authorization-code', 'primary', $1, now()
         )`,
        [payload],
      );

    await insertCredential("first-sealed-payload");

    await expect(insertCredential("second-sealed-payload")).rejects.toMatchObject({ code: "23505" });
  });

  it("deletes agent credentials when their connection is deleted", async () => {
    const handle = await createPostgresTestDbHandle();
    handles.push(handle);
    await handle.pool.query(
      `INSERT INTO agent_connections (id, name, base_url, auth_type, created_at, updated_at)
       VALUES ('agent_credential_cascade', 'Credential cascade', 'https://cascade.example.com', 'none', now(), now())`,
    );
    await handle.pool.query(
      `INSERT INTO agent_credentials (
         agent_connection_id, security_revision, credential_scope, scope_subject,
         auth_method, payload_encrypted, expires_at
       ) VALUES (
         'agent_credential_cascade', 1, 'connection', '',
         'oidc-client-credentials', 'sealed-payload', now()
       )`,
    );

    await handle.pool.query(`DELETE FROM agent_connections WHERE id = 'agent_credential_cascade'`);

    const result = await handle.pool.query<{ count: string }>(
      `SELECT count(*) FROM agent_credentials WHERE agent_connection_id = 'agent_credential_cascade'`,
    );
    expect(result.rows[0]?.count).toBe("0");
  });

  it("enforces agent credential scope and version constraints", async () => {
    const handle = await createPostgresTestDbHandle();
    handles.push(handle);
    await handle.pool.query(
      `INSERT INTO agent_connections (id, name, base_url, auth_type, created_at, updated_at)
       VALUES ('agent_credential_constraints', 'Credential constraints', 'https://constraints.example.com', 'none', now(), now())`,
    );
    const insertCredential = (securityRevision: number, credentialScope: string, scopeSubject: string, rotationSeq: number) =>
      handle.pool.query(
        `INSERT INTO agent_credentials (
           agent_connection_id, security_revision, credential_scope, scope_subject,
           auth_method, credential_key, payload_encrypted, expires_at, rotation_seq
         ) VALUES ($1, $2, $3, $4, 'oidc-authorization-code', $5, 'sealed-payload', now(), $6)`,
        [
          "agent_credential_constraints",
          securityRevision,
          credentialScope,
          scopeSubject,
          `${credentialScope}:${scopeSubject}:${securityRevision}:${rotationSeq}`,
          rotationSeq,
        ],
      );

    const invalidRows: Array<[number, string, string, number]> = [
      [1, "connection", "principal_user", 0],
      [1, "principal", "", 0],
      [1, "organization", "", 0],
      [0, "connection", "", 0],
      [1, "connection", "", -1],
    ];

    for (const row of invalidRows) {
      await expect(insertCredential(...row)).rejects.toMatchObject({ code: "23514" });
    }
    await expect(
      handle.pool.query(`UPDATE agent_connections SET security_revision = 0 WHERE id = 'agent_credential_constraints'`),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
