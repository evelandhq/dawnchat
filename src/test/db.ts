import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { DbClient } from "@/db/client";
import { schema } from "@/db/schema";

const defaultTestDatabaseUrl = "postgresql://eve_chats:eve_chats@127.0.0.1:55433/eve_chats";
const migrationDirectory = path.join(process.cwd(), "src/db/migrations");

type MigrationJournal = { entries: Array<{ tag: string }> };

export interface TestDbHandle {
  readonly db: DbClient;
  readonly pool: Pool;
  readonly schemaName: string;
  close(): Promise<void>;
}

async function applyGeneratedMigrations(pool: Pool, schemaName: string): Promise<void> {
  const journal = JSON.parse(
    await readFile(path.join(migrationDirectory, "meta/_journal.json"), "utf8"),
  ) as MigrationJournal;

  for (const entry of journal.entries) {
    const migrationSql = await readFile(path.join(migrationDirectory, `${entry.tag}.sql`), "utf8");
    const schemaScopedSql = migrationSql.replaceAll('"public".', `"${schemaName}".`);
    for (const statement of schemaScopedSql.split("--> statement-breakpoint")) {
      if (statement.trim()) {
        await pool.query(statement);
      }
    }
  }
}

export async function createPostgresTestDbHandle(): Promise<TestDbHandle> {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? defaultTestDatabaseUrl;
  const schemaName = `test_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
  let pool: Pool | undefined;

  try {
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
    });
    await applyGeneratedMigrations(pool, schemaName);
  } catch (error) {
    await pool?.end().catch(() => undefined);
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => undefined);
    await adminPool.end().catch(() => undefined);
    throw new Error(
      "Unable to create PostgreSQL test schema. Start it with `corepack pnpm db:up` and check TEST_DATABASE_URL.",
      { cause: error },
    );
  }

  let closePromise: Promise<void> | undefined;
  return {
    db: drizzle(pool, { schema }) as DbClient,
    pool,
    schemaName,
    close() {
      closePromise ??= (async () => {
        const errors: unknown[] = [];

        try {
          await pool.end();
        } catch (error) {
          errors.push(error);
        }

        try {
          await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
        } catch (error) {
          errors.push(error);
        } finally {
          try {
            await adminPool.end();
          } catch (error) {
            errors.push(error);
          }
        }

        if (errors.length > 0) {
          throw new AggregateError(errors, `Unable to clean up PostgreSQL test schema ${schemaName}`);
        }
      })();

      return closePromise;
    },
  };
}

export const createTestDbHandle = createPostgresTestDbHandle;
