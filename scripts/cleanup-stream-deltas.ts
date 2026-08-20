/**
 * One-time maintenance: delete historical `message.appended` /
 * `reasoning.appended` rows that the read path already hides.
 *
 * Chats persisted before the proxy stopped storing deltas hold a run of
 * cumulative-text rows per streamed message — one real conversation measured
 * 43 MB of deltas carrying 236 KB of information. The rows to delete are
 * computed by `collapseStreamedDeltas`, the same rule `GET
 * /api/chats/[chatId]` serves, so what a chat shows before and after the
 * cleanup is identical by construction.
 *
 * Usage:
 *   pnpm db:cleanup-deltas            # dry run: per-chat counts, no writes
 *   pnpm db:cleanup-deltas --apply    # delete, one transaction per chat
 *
 * Each chat is processed under the same advisory lock the proxy's stream tap
 * takes, so a live turn never interleaves with its chat's cleanup.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";

import { collapseStreamedDeltas } from "@/eve/stream-projection";

const DELTA_TYPES = ["message.appended", "reasoning.appended"] as const;

type EventRow = {
  id: string;
  type: string;
  payload_json: string;
};

export type ChatCleanupPlan = {
  chatId: string;
  deltaRows: number;
  deleteIds: string[];
};

/** The delta rows of one chat that the collapse rule discards. */
export function planChatCleanup(
  chatId: string,
  rows: readonly EventRow[],
): ChatCleanupPlan {
  const events = rows.map((row) => ({
    id: row.id,
    type: row.type,
    payload: JSON.parse(row.payload_json) as unknown,
  }));
  const kept = new Set(collapseStreamedDeltas(events).map((event) => event.id));
  const deltaTypes = new Set<string>(DELTA_TYPES);
  return {
    chatId,
    deltaRows: events.filter((event) => deltaTypes.has(event.type)).length,
    deleteIds: events
      .filter((event) => deltaTypes.has(event.type) && !kept.has(event.id))
      .map((event) => event.id),
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadEnv();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows: chats } = await client.query<{ chat_id: string }>(
      `select distinct chat_id from events where type = any($1)`,
      [DELTA_TYPES],
    );
    console.log(
      `${chats.length} chat(s) hold delta rows${apply ? "" : " (dry run — pass --apply to delete)"}`,
    );

    let totalRows = 0;
    let totalDeleted = 0;
    let totalBytes = 0;
    for (const { chat_id: chatId } of chats) {
      await client.query("begin");
      try {
        await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [chatId]);
        const { rows } = await client.query<EventRow>(
          `select id, type, payload_json from events
           where chat_id = $1
           order by event_index asc, id asc`,
          [chatId],
        );
        const plan = planChatCleanup(chatId, rows);
        const deleteIds = new Set(plan.deleteIds);
        const bytes = rows
          .filter((row) => deleteIds.has(row.id))
          .reduce((sum, row) => sum + row.payload_json.length, 0);
        totalRows += plan.deltaRows;
        totalBytes += bytes;
        if (apply && plan.deleteIds.length > 0) {
          const { rowCount } = await client.query(
            `delete from events where chat_id = $1 and id = any($2)`,
            [chatId, plan.deleteIds],
          );
          totalDeleted += rowCount ?? 0;
        }
        await client.query(apply ? "commit" : "rollback");
        console.log(
          `${chatId}: ${plan.deltaRows} delta row(s), ${plan.deleteIds.length} superseded (${formatBytes(bytes)})${apply ? " — deleted" : ""}`,
        );
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }

    console.log(
      apply
        ? `Deleted ${totalDeleted} of ${totalRows} delta row(s), reclaiming ${formatBytes(totalBytes)} of payload. Run VACUUM ANALYZE events to return the space.`
        : `Dry run: would delete ${formatBytes(totalBytes)} of payload from ${totalRows} delta row(s).`,
    );
  } finally {
    await client.end();
  }
}

function loadEnv(): void {
  if (process.env.DATABASE_URL) return;
  for (const filename of [".env.local", ".env"]) {
    const envPath = path.join(process.cwd(), filename);
    if (existsSync(envPath)) {
      process.loadEnvFile(envPath);
      if (process.env.DATABASE_URL) return;
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

if (process.argv[1]?.endsWith("cleanup-stream-deltas.ts")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
