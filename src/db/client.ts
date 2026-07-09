import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { schema } from "@/db/schema";

function normalizeSqliteFilename(databaseUrl: string): string {
  if (databaseUrl.startsWith("file:")) {
    return databaseUrl.slice("file:".length);
  }

  return databaseUrl;
}

export type DbClient = BetterSQLite3Database<typeof schema> & { readonly $client: Database.Database };

export function createDbClient(databaseUrl = process.env.DATABASE_URL ?? "file:./eve-chats.sqlite"): DbClient {
  const sqlite = new Database(normalizeSqliteFilename(databaseUrl));
  sqlite.pragma("foreign_keys = ON");

  return drizzle(sqlite, { schema }) as DbClient;
}
