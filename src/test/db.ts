import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { schema } from "@/db/schema";

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

export function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyInitialMigration(sqlite);

  return drizzle(sqlite, { schema });
}
