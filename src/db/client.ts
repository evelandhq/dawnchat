import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { schema } from "@/db/schema";

export type DbClient = NodePgDatabase<typeof schema> & { readonly $client: Pool };

export function createDbClient(databaseUrl = process.env.DATABASE_URL): DbClient {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required (see docs/local-development.md)");
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
  });
  return drizzle(pool, { schema }) as DbClient;
}
