import { createDbClient, type DbClient } from "@/db/client";

let dbClient: DbClient | null = null;
let testDbClient: DbClient | null = null;

export function getDbClient(): DbClient {
  if (testDbClient) {
    return testDbClient;
  }

  dbClient ??= createDbClient();
  return dbClient;
}

export function setDbClientForTests(db: DbClient | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setDbClientForTests may only be used while testing");
  }

  testDbClient = db;
}
