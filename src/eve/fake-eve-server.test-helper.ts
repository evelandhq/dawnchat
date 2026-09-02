import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

export interface CapturedEveRequest {
  method: string;
  path: string;
  query: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

/** Eve versions currently hosted by Eveland and supported by Dawn. */
export const SUPPORTED_EVE_GENERATIONS = ["0.47", "0.49"] as const;
export type FakeEveGeneration = (typeof SUPPORTED_EVE_GENERATIONS)[number];

export interface FakeEveServerOptions {
  readonly authenticationChallenge?: {
    readonly header: string;
    readonly body: unknown;
    readonly acceptedAuthorization: string;
    readonly headers?: Readonly<Record<string, string>>;
  };
  /** Defaults to the newest verified generation. */
  readonly generation?: FakeEveGeneration;
  readonly redirectHealthTo?: string;
  readonly failCreateSession?: boolean;
  /** Reject this many continuation attempts while Eve activates the session. */
  readonly continueSessionNotActiveCount?: number;
  readonly streamEvents?: readonly unknown[];
  /** Emit stream events without ending the response, like a live Agent. */
  readonly holdStreamOpen?: boolean;
  /** Eve answers `no_active_turn` when a cancel arrives between turns. */
  readonly cancelStatus?: "accepted" | "no_active_turn";
}

const SUPPORTED_STREAM_VERSION = 24;

export interface FakeEveServer {
  readonly baseUrl: string;
  readonly requests: CapturedEveRequest[];
  close(): Promise<void>;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function writeNdjson(
  response: ServerResponse,
  events: readonly unknown[],
  holdOpen: boolean,
  streamVersion: number,
): void {
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "x-eve-stream-format": "ndjson",
    "x-eve-stream-version": String(streamVersion),
  });

  for (const event of events) {
    response.write(`${JSON.stringify(event)}\n`);
  }
  if (!holdOpen) {
    response.end();
  }
}

export async function startFakeEveServer(options: FakeEveServerOptions = {}): Promise<FakeEveServer> {
  const generation = options.generation ?? "0.49";
  if (!SUPPORTED_EVE_GENERATIONS.includes(generation)) {
    throw new Error(`Unsupported fake Eve generation: ${generation}`);
  }

  const requests: CapturedEveRequest[] = [];
  let nextSessionId = 1;
  let remainingSessionNotActiveResponses = options.continueSessionNotActiveCount ?? 0;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let body: unknown = null;

    try {
      if (request.method !== "GET") {
        body = await readJsonBody(request);
      }

      requests.push({ method: request.method ?? "GET", path: url.pathname, query: url.search, headers: request.headers, body });

      if (request.method === "GET" && url.pathname === "/eve/v1/health" && options.redirectHealthTo) {
        response.writeHead(302, { location: options.redirectHealthTo });
        response.end();
        return;
      }

      if (request.method === "GET" && url.pathname === "/eve/v1/health") {
        writeJson(response, 200, { ok: true, status: "ready", workflowId: "fake-workflow" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/eve/v1/info") {
        writeJson(response, 200, { name: "Fake Eve Agent" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/eve/v1/session") {
        if (
          options.authenticationChallenge &&
          request.headers.authorization !==
            options.authenticationChallenge.acceptedAuthorization
        ) {
          response.writeHead(401, {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
            "www-authenticate": options.authenticationChallenge.header,
            ...options.authenticationChallenge.headers,
          });
          response.end(JSON.stringify(options.authenticationChallenge.body));
          return;
        }
        if (options.failCreateSession) {
          writeJson(response, 500, {
            error: "Failed to create fake session",
            errorId: "err_fake_session_create",
            ok: false,
          });
          return;
        }

        const id = nextSessionId++;
        writeJson(response, 202, {
          ok: true,
          sessionId: `ses_${id}`,
          status: "accepted",
        });
        return;
      }

      const continueMatch = url.pathname.match(/^\/eve\/v1\/session\/(ses_\d+)$/);
      if (request.method === "POST" && continueMatch) {
        const sessionId = continueMatch[1];
        const suppliedToken = (body as { continuationToken?: unknown } | null)?.continuationToken;
        if (suppliedToken !== undefined) {
          writeJson(response, 400, {
            ok: false,
            error: "Session-ID routes do not accept 'continuationToken'.",
          });
          return;
        }
        if (remainingSessionNotActiveResponses > 0) {
          remainingSessionNotActiveResponses -= 1;
          writeJson(response, 409, {
            ok: false,
            code: "session_not_active",
            error: "The session is no longer active.",
          });
          return;
        }
        writeJson(response, 202, { ok: true, sessionId, status: "accepted" });
        return;
      }

      const streamMatch = url.pathname.match(/^\/eve\/v1\/session\/(ses_\d+)\/stream$/);
      if (request.method === "GET" && streamMatch) {
        writeNdjson(
          response,
          options.streamEvents ?? [
            {
              type: "message.appended",
              data: { messageDelta: "Hello", messageSoFar: "Hello", sequence: 1, stepIndex: 0, turnId: "turn_1" },
            },
            {
              type: "message.completed",
              data: { message: "Hello", finishReason: "stop", sequence: 2, stepIndex: 0, turnId: "turn_1" },
            },
            { type: "session.waiting", data: { wait: "next-user-message" } },
          ],
          options.holdStreamOpen ?? false,
          SUPPORTED_STREAM_VERSION,
        );
        return;
      }

      const cancelMatch = url.pathname.match(/^\/eve\/v1\/session\/(ses_\d+)\/cancel$/);
      if (request.method === "POST" && cancelMatch) {
        // Eve's CancelTurnResponseSchema is strict: only the accepted variant
        // names the session.
        writeJson(
          response,
          202,
          options.cancelStatus === "no_active_turn"
            ? { ok: true, status: "no_active_turn" }
            : { ok: true, sessionId: cancelMatch[1], status: "accepted" },
        );
        return;
      }

      writeJson(response, 404, { error: "Not found" });
    } catch (error) {
      writeJson(response, 500, { error: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected TCP server address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  server.close();
  // Held-open NDJSON streams would otherwise keep the server alive forever.
  server.closeAllConnections();
  await once(server, "close");
}
