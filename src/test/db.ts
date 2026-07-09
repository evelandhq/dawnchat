import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { schema } from "@/db/schema";
import type { DbClient } from "@/db/client";

function applyInitialMigration(sqlite: Database.Database) {
  const migrationPath = path.join(process.cwd(), "src/db/migrations/0000_aromatic_ultragirl.sql");
  const migrationSql = readFileSync(migrationPath, "utf8");

  for (const statement of migrationSql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) {
      sqlite.exec(trimmed);
    }
  }
}

export interface TestDbHandle {
  readonly db: DbClient;
  close(): void;
}

export function createTestDb(): DbClient {
  return createTestDbHandle().db;
}

export function createTestDbHandle(): TestDbHandle {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyInitialMigration(sqlite);

  return {
    db: drizzle(sqlite, { schema }) as DbClient,
    close: () => sqlite.close(),
  };
}
