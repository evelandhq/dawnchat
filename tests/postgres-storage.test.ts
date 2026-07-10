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
});
