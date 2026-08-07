import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

export interface CapturedEveRequest {
  method: string;
  path: string;
  query: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

export interface FakeEveServerOptions {
  readonly authenticationChallenge?: {
    readonly header: string;
    readonly body: unknown;
    readonly acceptedAuthorization: string;
    readonly headers?: Readonly<Record<string, string>>;
  };
  readonly omitContinuationTokenOnContinue?: boolean;
  readonly redirectHealthTo?: string;
  readonly failCreateSession?: boolean;
  readonly streamEvents?: readonly unknown[];
  readonly streamVersion?: 18 | 19;
  /** Emit stream events without ending the response, like eve 0.18.x agents. */
  readonly holdStreamOpen?: boolean;
  /** End the stream normally without emitting an event. */
  readonly emptyStream?: boolean;
  /** Emit invalid NDJSON so the client iterator throws before yielding its first event. */
  readonly malformedStream?: boolean;
  /** Slice configured stream events by the requested absolute start index. */
  readonly respectStreamStartIndex?: boolean;
  /**
   * Events served on stream reads once a cancel has been accepted, always sliced
   * by the requested absolute start index. Models eve confirming a cancellation
   * with `turn.cancelled` followed by a fresh `session.waiting`.
   */
  readonly cancelledStreamEvents?: readonly unknown[];
}

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
  holdOpen = false,
  streamVersion: 18 | 19 = 18,
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
  const requests: CapturedEveRequest[] = [];
  let nextSessionId = 1;
  let cancelled = false;

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
        writeJson(response, 200, { ok: true, status: "ready", workflowId: "fake-workflow", name: "Fake Eve Agent" });
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
          writeJson(response, 500, { error: "Failed to create fake session" });
          return;
        }

        const id = nextSessionId++;
        writeJson(response, 200, { ok: true, sessionId: `ses_${id}`, continuationToken: `eve:${id}` });
        return;
      }

      const continueMatch = url.pathname.match(/^\/eve\/v1\/session\/(ses_\d+)$/);
      if (request.method === "POST" && continueMatch) {
        const id = continueMatch[1].replace("ses_", "");
        const responseBody = options.omitContinuationTokenOnContinue
          ? { ok: true, sessionId: continueMatch[1] }
          : { ok: true, sessionId: continueMatch[1], continuationToken: `eve:${id}` };
        writeJson(response, 200, responseBody);
        return;
      }

      const streamMatch = url.pathname.match(/^\/eve\/v1\/session\/(ses_\d+)\/stream$/);
      if (request.method === "GET" && streamMatch) {
        if (cancelled && options.cancelledStreamEvents !== undefined) {
          writeNdjson(
            response,
            options.cancelledStreamEvents.slice(Number(url.searchParams.get("startIndex") ?? 0)),
            false,
            options.streamVersion,
          );
          return;
        }

        if (options.emptyStream) {
          response.writeHead(200, {
            "content-type": "application/x-ndjson; charset=utf-8",
            "x-eve-stream-format": "ndjson",
          });
          response.end();
          return;
        }

        if (options.malformedStream) {
          response.writeHead(200, {
            "content-type": "application/x-ndjson; charset=utf-8",
            "x-eve-stream-format": "ndjson",
          });
          response.end("not-json\n");
          return;
        }

        const startIndex = options.respectStreamStartIndex
          ? Number(url.searchParams.get("startIndex") ?? 0)
          : 0;
        writeNdjson(
          response,
          (options.streamEvents ?? [
            {
              type: "message.appended",
              data: { messageDelta: "Hello", messageSoFar: "Hello", sequence: 1, stepIndex: 0, turnId: "turn_1" },
            },
            {
              type: "message.completed",
              data: { message: "Hello", finishReason: "stop", sequence: 2, stepIndex: 0, turnId: "turn_1" },
            },
            { type: "session.waiting", data: { wait: "next-user-message" } },
          ]).slice(startIndex),
          options.holdStreamOpen,
          options.streamVersion,
        );
        return;
      }

      const cancelMatch = url.pathname.match(/^\/eve\/v1\/session\/(ses_\d+)\/cancel$/);
      if (request.method === "POST" && cancelMatch) {
        cancelled = true;
        writeJson(response, 200, {
          ok: true,
          sessionId: cancelMatch[1],
          status: "accepted",
        });
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
