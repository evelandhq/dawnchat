import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { schema } from "@/db/schema";

function normalizeSqliteFilename(databaseUrl: string): string {
  if (databaseUrl.startsWith("file:")) {
    return databaseUrl.slice("file:".length);
  }

  return databaseUrl;
}

export function createDbClient(databaseUrl = process.env.DATABASE_URL ?? "file:./eve-chats.sqlite") {
  const sqlite = new Database(normalizeSqliteFilename(databaseUrl));
  sqlite.pragma("foreign_keys = ON");

  return drizzle(sqlite, { schema });
}

export type DbClient = ReturnType<typeof createDbClient>;
