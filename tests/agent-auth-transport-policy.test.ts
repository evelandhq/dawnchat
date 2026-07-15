import { describe, expect, it, vi } from "vitest";

import {
  AgentTransportConfigurationError,
  AgentTransportUpstreamUnavailableError,
  createAgentTransport,
  prepareAgentTransportInit,
  type AgentTransportFetch,
  type HostnameResolver,
} from "@/agent-auth/transport";

const publicAddress = "93.184.216.34";

function policyHarness(options?: {
  readonly addresses?: readonly string[];
  readonly resolverError?: unknown;
  readonly allowInsecureHttp?: boolean;
  readonly allowlistedHostnames?: readonly string[];
}) {
  const fetchImpl: AgentTransportFetch = vi.fn(async () => new Response("ok"));
  const resolveHostname: HostnameResolver = vi.fn(async () => {
    if (options && "resolverError" in options) {
      throw options.resolverError;
    }
    return options?.addresses ? [...options.addresses] : [publicAddress];
  });
  const transport = createAgentTransport({
    fetch: fetchImpl,
    resolveHostname,
    policy: {
      allowInsecureHttp: options?.allowInsecureHttp,
      allowlistedHostnames: options?.allowlistedHostnames,
    },
  });

  return { fetchImpl, resolveHostname, transport };
}

function outboundRequest(baseUrl: string, pathname = "/eve/v1/info") {
  return {
    baseUrl,
    credential: { kind: "none" } as const,
    target: { pathname },
    init: prepareAgentTransportInit(),
  };
}

async function expectPolicyFailure(
  promise: Promise<Response>,
  fetchImpl: AgentTransportFetch,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "AgentTransportConfigurationError",
    kind: "configuration_invalid",
  });
  await expect(promise).rejects.toBeInstanceOf(AgentTransportConfigurationError);
  expect(fetchImpl).not.toHaveBeenCalled();
}

describe("Agent transport pathname policy", () => {
  it.each([
    ["absolute URL", "https://evil.example/eve/v1/info"],
    ["network-path reference", "//evil.example/eve/v1/info"],
    ["more than one leading slash", "///eve/v1/info"],
    ["query embedded in pathname", "/eve/v1/info?secret=true"],
    ["hash embedded in pathname", "/eve/v1/info#fragment"],
    ["backslash", "/eve\\v1/info"],
    ["control character", "/eve/v1/\u0000info"],
    ["raw current-directory segment", "/eve/./v1/info"],
    ["raw parent-directory segment", "/eve/v1/../info"],
    ["single-encoded dot segment", "/eve/v1/%2e%2e/info"],
    ["mixed single-encoded dot segment", "/eve/v1/.%2E/info"],
    ["double-encoded dot segment", "/eve/v1/%252e%252e/info"],
    ["nested-encoded slash and dot segment", "/eve/v1/%252e%252e%252fprivate"],
    ["malformed percent encoding", "/eve/v1/%2/info"],
  ])("rejects %s before fetch", async (_name, pathname) => {
    const { fetchImpl, transport } = policyHarness();

    await expectPolicyFailure(
      transport.request(outboundRequest("https://agent.example/deploy", pathname)),
      fetchImpl,
    );
  });
});

describe("Agent transport base URL and SSRF policy", () => {
  it.each([
    ["malformed URL", "not a URL"],
    ["unsupported protocol", "ftp://agent.example/deploy"],
    ["insecure HTTP by default", "http://agent.example/deploy"],
    ["username", "https://user@agent.example/deploy"],
    ["password", "https://user:secret@agent.example/deploy"],
    ["query", "https://agent.example/deploy?mode=private"],
    ["empty query", "https://agent.example/deploy?"],
    ["hash", "https://agent.example/deploy#fragment"],
    ["empty hash", "https://agent.example/deploy#"],
  ])("rejects %s before fetch", async (_name, baseUrl) => {
    const { fetchImpl, transport } = policyHarness();

    await expectPolicyFailure(transport.request(outboundRequest(baseUrl)), fetchImpl);
  });

  it.each([
    ["unspecified IPv4", "0.0.0.0"],
    ["private IPv4 /8", "10.2.3.4"],
    ["CGNAT IPv4", "100.64.0.1"],
    ["loopback IPv4", "127.0.0.1"],
    ["link-local/cloud metadata IPv4", "169.254.169.254"],
    ["private IPv4 /12", "172.16.2.3"],
    ["private IPv4 /16", "192.168.2.3"],
    ["documentation IPv4", "192.0.2.4"],
    ["benchmark IPv4", "198.18.0.1"],
    ["documentation IPv4 TEST-NET-2", "198.51.100.8"],
    ["documentation IPv4 TEST-NET-3", "203.0.113.8"],
    ["multicast IPv4", "224.0.0.1"],
    ["reserved IPv4", "240.0.0.1"],
    ["loopback IPv6", "[::1]"],
    ["unspecified IPv6", "[::]"],
    ["private IPv6", "[fc00::1]"],
    ["link-local IPv6", "[fe80::1]"],
    ["documentation IPv6", "[2001:db8::1]"],
    ["multicast IPv6", "[ff02::1]"],
  ])("default-denies literal %s", async (_name, hostname) => {
    const { fetchImpl, resolveHostname, transport } = policyHarness();

    await expectPolicyFailure(
      transport.request(outboundRequest(`https://${hostname}/deploy`)),
      fetchImpl,
    );
    expect(resolveHostname).not.toHaveBeenCalled();
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["private", "10.1.2.3"],
    ["link-local/cloud metadata", "169.254.169.254"],
    ["CGNAT", "100.64.3.4"],
    ["documentation/reserved", "203.0.113.10"],
    ["multicast", "224.0.0.1"],
    ["private IPv6", "fd00::1"],
    ["link-local IPv6", "fe80::1"],
  ])("default-denies a hostname resolving to %s", async (_name, address) => {
    const { fetchImpl, resolveHostname, transport } = policyHarness({ addresses: [address] });

    await expectPolicyFailure(
      transport.request(outboundRequest("https://agent.example/deploy")),
      fetchImpl,
    );
    expect(resolveHostname).toHaveBeenCalledWith("agent.example");
  });

  it("fails closed when any address in a mixed DNS answer is non-public", async () => {
    const { fetchImpl, transport } = policyHarness({ addresses: [publicAddress, "10.1.2.3"] });

    await expectPolicyFailure(
      transport.request(outboundRequest("https://agent.example/deploy")),
      fetchImpl,
    );
  });

  it("rejects a well-known cloud metadata hostname without resolving it", async () => {
    const { fetchImpl, resolveHostname, transport } = policyHarness();

    await expectPolicyFailure(
      transport.request(outboundRequest("https://metadata.google.internal/computeMetadata/v1")),
      fetchImpl,
    );
    expect(resolveHostname).not.toHaveBeenCalled();
  });

  it.each([
    ["resolver failure", undefined, new Error("DNS timeout for internal resolver")],
    ["empty DNS answer", [] as const, undefined],
  ])("classifies %s as upstream unavailable", async (_name, addresses, resolverError) => {
    const { fetchImpl, transport } = policyHarness({ addresses, resolverError });

    const promise = transport.request(outboundRequest("https://agent.example/deploy"));

    await expect(promise).rejects.toMatchObject({
      name: "AgentTransportUpstreamUnavailableError",
      kind: "upstream_unavailable",
      message: "The Agent hostname could not be resolved",
    });
    await expect(promise).rejects.toBeInstanceOf(AgentTransportUpstreamUnavailableError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a hostname only when every DNS answer is public", async () => {
    const { fetchImpl, transport } = policyHarness({
      addresses: ["93.184.216.34", "2606:4700:4700::1111"],
    });

    await expect(
      transport.request(outboundRequest("https://agent.example/deployment-prefix")),
    ).resolves.toBeInstanceOf(Response);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("allows an exact deployment allowlist entry to opt a local HTTP host into use", async () => {
    const { fetchImpl, resolveHostname, transport } = policyHarness({
      allowInsecureHttp: true,
      allowlistedHostnames: ["LOCALHOST"],
    });

    await expect(
      transport.request(outboundRequest("http://localhost:3000/deployment")),
    ).resolves.toBeInstanceOf(Response);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(resolveHostname).not.toHaveBeenCalled();
  });

  it("still rejects public HTTP hosts that are outside the exact insecure allowlist", async () => {
    const { fetchImpl, transport } = policyHarness({
      allowInsecureHttp: true,
      allowlistedHostnames: ["localhost", "127.0.0.1", "::1"],
    });

    await expectPolicyFailure(
      transport.request(outboundRequest("http://agent.example/deployment")),
      fetchImpl,
    );
  });
  it("does not treat a suffix lookalike as an exact allowlist match", async () => {
    const { fetchImpl, transport } = policyHarness({
      addresses: ["127.0.0.1"],
      allowInsecureHttp: true,
      allowlistedHostnames: ["localhost"],
    });

    await expectPolicyFailure(
      transport.request(outboundRequest("http://notlocalhost/local-agent")),
      fetchImpl,
    );
  });

  it("still requires an explicit HTTP opt-in for an allowlisted host", async () => {
    const { fetchImpl, transport } = policyHarness({ allowlistedHostnames: ["localhost"] });

    await expectPolicyFailure(
      transport.request(outboundRequest("http://localhost/local-agent")),
      fetchImpl,
    );
  });
});
