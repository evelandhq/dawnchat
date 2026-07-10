import { existsSync } from "node:fs";
import path from "node:path";

import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  for (const filename of [".env.local", ".env"]) {
    const envPath = path.join(process.cwd(), filename);
    if (existsSync(envPath)) {
      process.loadEnvFile(envPath);
      if (process.env.DATABASE_URL) break;
    }
  }
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for Drizzle commands (copy .env.example to .env.local)");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: databaseUrl },
});
