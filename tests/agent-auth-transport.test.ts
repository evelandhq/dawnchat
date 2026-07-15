import { describe, expect, it, vi } from "vitest";

import type {
  AgentRequestInit,
  AgentRequestTarget,
  CredentialSnapshot,
} from "@/agent-auth/contracts";
import {
  AgentTransportConfigurationError,
  AgentTransportUpstreamUnavailableError,
  createAgentTransport,
  prepareAgentTransportInit,
  type AgentTransportFetch,
  type AgentTransportInit,
  type HostnameResolver,
} from "@/agent-auth/transport";

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

function transportHarness(options?: {
  readonly response?: Response;
  readonly fetchError?: unknown;
  readonly resolvedAddresses?: readonly string[];
}) {
  const calls: FetchCall[] = [];
  const response = options?.response ?? new Response("ok", { status: 200 });
  const fetchImpl: AgentTransportFetch = vi.fn(async (input, init) => {
    if (options && "fetchError" in options) {
      throw options.fetchError;
    }
    calls.push({ url: String(input), init: init ?? {} });
    return response;
  });
  const resolveHostname: HostnameResolver = vi.fn(async () =>
    options?.resolvedAddresses ? [...options.resolvedAddresses] : ["93.184.216.34"],
  );
  const transport = createAgentTransport({ fetch: fetchImpl, resolveHostname });

  return { calls, fetchImpl, resolveHostname, response, transport };
}

function request(
  credential: CredentialSnapshot,
  target: AgentRequestTarget = { pathname: "/eve/v1/info" },
  init?: AgentRequestInit,
) {
  return {
    baseUrl: "https://agent.example/deploy/api/",
    credential,
    target,
    init: prepareAgentTransportInit(init),
  };
}

async function expectConfigurationFailure(
  promise: Promise<Response>,
  fetchImpl: AgentTransportFetch,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AgentTransportConfigurationError);
  expect(fetchImpl).not.toHaveBeenCalled();
}

describe("Agent transport request construction", () => {
  it("preserves the deployment prefix and composes pathname and structured search params", async () => {
    const { calls, resolveHostname, transport } = transportHarness();

    await transport.request(
      request(
        { kind: "none" },
        {
          pathname: "/eve/v1/session/session%2Fone/stream",
          searchParams: { startIndex: "7", cursor: "a&b = c" },
        },
      ),
    );

    expect(resolveHostname).toHaveBeenCalledOnce();
    expect(resolveHostname).toHaveBeenCalledWith("agent.example");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://agent.example/deploy/api/eve/v1/session/session%2Fone/stream?startIndex=7&cursor=a%26b+%3D+c",
    );
  });

  it("materializes a prepared POST JSON body and content type without re-serializing it", async () => {
    const { calls, transport } = transportHarness();
    let serializationCount = 0;
    const jsonBody = {
      toJSON() {
        serializationCount += 1;
        return { message: "hello" };
      },
    };
    const credentialValue = ["agent", "value"].join("-");
    const credentialHeaders: Record<string, string> = {};
    Object.defineProperty(credentialHeaders, "Authorization", {
      enumerable: true,
      get() {
        expect(serializationCount).toBe(1);
        return credentialValue;
      },
    });
    const init = prepareAgentTransportInit({ method: "POST", jsonBody });

    expect(serializationCount).toBe(1);
    expect(init).toMatchObject({ method: "POST", body: '{"message":"hello"}' });
    expect(Object.isFrozen(init)).toBe(true);

    await transport.request({
      baseUrl: "https://agent.example/deploy/api/",
      credential: { kind: "headers", headers: credentialHeaders },
      target: { pathname: "/eve/v1/session" },
      init,
    });

    expect(serializationCount).toBe(1);
    expect(calls).toHaveLength(1);
    const fetchInit = calls[0]!.init;
    expect(fetchInit.method).toBe("POST");
    expect(fetchInit.body).toBe('{"message":"hello"}');
    expect(new Headers(fetchInit.headers)).toEqual(
      new Headers({
        "content-type": "application/json",
        authorization: credentialValue,
      }),
    );
  });

  it.each<{
    name: string;
    credential: CredentialSnapshot;
    expectedHeaders: Record<string, string>;
  }>([
    { name: "none", credential: { kind: "none" }, expectedHeaders: {} },
    {
      name: "basic",
      credential: { kind: "basic", username: "alice", password: "secret" },
      expectedHeaders: { authorization: "Basic YWxpY2U6c2VjcmV0" },
    },
    {
      name: "bearer",
      credential: { kind: "bearer", token: "  token-value  " },
      expectedHeaders: { authorization: "Bearer token-value" },
    },
    {
      name: "headers with an explicit Cookie credential",
      credential: {
        kind: "headers",
        headers: { "x-api-key": "key-value", Cookie: "agent_session=credential" },
      },
      expectedHeaders: { "x-api-key": "key-value", cookie: "agent_session=credential" },
    },
  ])("materializes $name credentials", async ({ credential, expectedHeaders }) => {
    const { calls, transport } = transportHarness();

    await transport.request(request(credential));

    expect(Object.fromEntries(new Headers(calls[0]!.init.headers).entries())).toEqual(expectedHeaders);
  });

  it("always uses manual redirects and returns a raw 3xx Response", async () => {
    const response = new Response(null, {
      status: 307,
      headers: { location: "https://redirect.example/elsewhere" },
    });
    const { calls, transport } = transportHarness({ response });

    const result = await transport.request(request({ kind: "bearer", token: "secret" }));

    expect(result).toBe(response);
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  it("forwards AbortSignal and propagates the same AbortError object", async () => {
    const abortError = new DOMException("cancelled", "AbortError");
    const controller = new AbortController();
    const { fetchImpl, transport } = transportHarness({ fetchError: abortError });

    const promise = transport.request(
      request({ kind: "none" }, { pathname: "/eve/v1/info" }, { signal: controller.signal }),
    );

    await expect(promise).rejects.toBe(abortError);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("propagates the exact custom abort reason instead of classifying it as an outage", async () => {
    const abortReason = new Error("caller cancelled with a custom reason");
    const controller = new AbortController();
    controller.abort(abortReason);
    const { fetchImpl, transport } = transportHarness({ fetchError: abortReason });

    const promise = transport.request(
      request({ kind: "none" }, { pathname: "/eve/v1/info" }, { signal: controller.signal }),
    );

    await expect(promise).rejects.toBe(abortReason);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("classifies genuine fetch failures as upstream unavailable without exposing the cause", async () => {
    const networkError = new TypeError("connect ECONNREFUSED secret.internal:443");
    const { transport } = transportHarness({ fetchError: networkError });

    const promise = transport.request(request({ kind: "none" }));

    await expect(promise).rejects.toMatchObject({
      name: "AgentTransportUpstreamUnavailableError",
      kind: "upstream_unavailable",
      message: "The Agent is unavailable",
      cause: networkError,
    });
    await expect(promise).rejects.toBeInstanceOf(AgentTransportUpstreamUnavailableError);
  });

  it("rejects a JSON body on GET while preparing, before transport side effects", () => {
    const { fetchImpl, resolveHostname } = transportHarness();

    expect(() =>
      prepareAgentTransportInit({
        method: "GET",
        jsonBody: { disallowed: true },
      }),
    ).toThrow(AgentTransportConfigurationError);
    expect(resolveHostname).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an unprepared init at the transport seam before DNS or fetch", async () => {
    const { fetchImpl, resolveHostname, transport } = transportHarness();
    const forgedInit = Object.freeze({ method: "GET" }) as AgentTransportInit;

    await expectConfigurationFailure(
      transport.request({
        baseUrl: "https://agent.example/deploy/api/",
        credential: { kind: "none" },
        target: { pathname: "/eve/v1/info" },
        init: forgedInit,
      }),
      fetchImpl,
    );
    expect(resolveHostname).not.toHaveBeenCalled();
  });

  it("reads request.init once and consumes the same prepared value it validated", async () => {
    const { calls, transport } = transportHarness();
    const prepared = prepareAgentTransportInit();
    let initReads = 0;
    const transportRequest = {
      baseUrl: "https://agent.example/deploy/api/",
      credential: { kind: "none" } as const,
      target: { pathname: "/eve/v1/info" },
      get init(): AgentTransportInit {
        initReads += 1;
        return initReads === 1
          ? prepared
          : (Object.freeze({ method: "DELETE" }) as unknown as AgentTransportInit);
      },
    };

    await transport.request(transportRequest);

    expect(initReads).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("rejects a frozen accessor init forged with a reflected private brand", async () => {
    const { fetchImpl, resolveHostname, transport } = transportHarness();
    const legitimate = prepareAgentTransportInit({ method: "POST" });
    const brand = Object.getOwnPropertySymbols(legitimate)[0]!;
    let methodReads = 0;
    const forged = {};
    Object.defineProperties(forged, {
      [brand]: { value: true, enumerable: false, configurable: false, writable: false },
      method: {
        enumerable: true,
        configurable: false,
        get() {
          methodReads += 1;
          return methodReads <= 3 ? "POST" : "DELETE";
        },
      },
    });
    Object.freeze(forged);

    await expectConfigurationFailure(
      transport.request({
        baseUrl: "https://agent.example/deploy/api/",
        credential: { kind: "none" },
        target: { pathname: "/eve/v1/info" },
        init: forged as AgentTransportInit,
      }),
      fetchImpl,
    );
    expect(resolveHostname).not.toHaveBeenCalled();
  });

  it("reads target and pathname once so a getter cannot escape the deployment prefix", async () => {
    const { calls, transport } = transportHarness();
    let targetReads = 0;
    let pathnameReads = 0;
    const firstTarget = {
      get pathname() {
        pathnameReads += 1;
        return pathnameReads === 1 ? "/safe" : "/../admin";
      },
    };
    const transportRequest = {
      baseUrl: "https://agent.example/deploy/api/",
      credential: { kind: "none" } as const,
      get target(): AgentRequestTarget {
        targetReads += 1;
        return targetReads === 1 ? firstTarget : { pathname: "/../admin" };
      },
      init: prepareAgentTransportInit(),
    };

    await transport.request(transportRequest);

    expect(targetReads).toBe(1);
    expect(pathnameReads).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://agent.example/deploy/api/safe");
  });
});

describe("Agent transport credential header policy", () => {
  it.each([
    "Host",
    "Content-Length",
    "Connection",
    "Keep-Alive",
    "Transfer-Encoding",
    "TE",
    "Trailer",
    "Upgrade",
    "Proxy-Authorization",
    "Proxy-Custom-Identity",
    "Forwarded",
    "X-Forwarded-For",
    "x-forwarded-custom",
  ])("rejects reserved header %s before fetch", async (name) => {
    const { fetchImpl, transport } = transportHarness();

    await expectConfigurationFailure(
      transport.request(request({ kind: "headers", headers: { [name]: "value" } })),
      fetchImpl,
    );
  });

  it.each<{ name: string; credential: CredentialSnapshot }>([
    { name: "bad field name", credential: { kind: "headers", headers: { "bad name": "value" } } },
    {
      name: "CR in a field value",
      credential: { kind: "headers", headers: { "x-api-key": "first\rsecond" } },
    },
    {
      name: "LF in a field value",
      credential: { kind: "headers", headers: { "x-api-key": "first\nsecond" } },
    },
    {
      name: "case-insensitive duplicate field names",
      credential: {
        kind: "headers",
        headers: Object.fromEntries([
          ["Author" + "ization", "first"],
          ["author" + "ization", "second"],
        ]),
      },
    },
    { name: "blank bearer", credential: { kind: "bearer", token: " \t " } },
    { name: "bearer with CRLF", credential: { kind: "bearer", token: "good\r\nbad" } },
  ])(
    "rejects $name before fetch",
    async ({ credential }) => {
      const { fetchImpl, transport } = transportHarness();

      await expectConfigurationFailure(transport.request(request(credential)), fetchImpl);
    },
  );
});

// These public value contracts deliberately have no arbitrary headers, body, or redirect controls.
const publicTargetContract: AgentRequestTarget = {
  pathname: "/eve/v1/stream",
  searchParams: { startIndex: "4" },
};
const publicInitContract: AgentRequestInit = {
  method: "POST",
  jsonBody: { message: "hello" },
  signal: new AbortController().signal,
};
void publicTargetContract;
void publicInitContract;
// @ts-expect-error arbitrary outbound headers are not part of the public contract
const initWithHeaders: AgentRequestInit = { headers: { "x-test": "value" } };
// @ts-expect-error arbitrary bodies are not part of the public contract
const initWithBody: AgentRequestInit = { body: "not replayable" };
// @ts-expect-error redirect behavior is owned by the transport
const initWithRedirect: AgentRequestInit = { redirect: "follow" };
void initWithHeaders;
void initWithBody;
void initWithRedirect;
