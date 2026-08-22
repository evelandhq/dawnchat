import { createDbClient, type DbClient } from "@/db/client";

const globalForDb = globalThis as typeof globalThis & {
  __dawnDbClient?: DbClient;
};

let dbClient: DbClient | null = globalForDb.__dawnDbClient ?? null;
let testDbClient: DbClient | null = null;

export function getDbClient(): DbClient {
  if (testDbClient) {
    return testDbClient;
  }

  if (!dbClient) {
    dbClient = createDbClient();
    if (process.env.NODE_ENV !== "production") {
      globalForDb.__dawnDbClient = dbClient;
    }
  }
  return dbClient;
}

export function setDbClientForTests(db: DbClient | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setDbClientForTests may only be used while testing");
  }

  testDbClient = db;
}
