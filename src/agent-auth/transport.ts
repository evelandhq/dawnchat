import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type {
  AgentRequestInit,
  AgentRequestTarget,
  CredentialSnapshot,
} from "@/agent-auth/contracts";

const HTTP_FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const RAW_CONTROL = /[\u0000-\u001f\u007f]/;
const RESERVED_HEADER_NAMES = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "forwarded",
]);
const METADATA_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);
const MAX_PATH_DECODE_PASSES = 32;
const AGENT_TRANSPORT_INIT_BRAND = Symbol("AgentTransportInit");
const PREPARED_AGENT_TRANSPORT_INITS = new WeakSet<object>();

export type AgentTransportFetch = (input: URL, init: RequestInit) => Promise<Response>;
export type HostnameResolver = (hostname: string) => Promise<readonly string[]>;

export interface AgentTransportPolicy {
  /**
   * Disabled by default. When enabled, plaintext HTTP is still accepted only
   * for exact entries in `allowlistedHostnames`.
   */
  readonly allowInsecureHttp?: boolean;
  /**
   * Exact hostname exceptions for deployment-owned targets such as local dev.
   * Entries bypass address-range checks, so this must not contain user input.
   */
  readonly allowlistedHostnames?: readonly string[];
}

export interface CreateAgentTransportOptions {
  readonly fetch?: AgentTransportFetch;
  readonly resolveHostname?: HostnameResolver;
  readonly policy?: AgentTransportPolicy;
}

export interface AgentTransportInit {
  readonly method: "GET" | "POST";
  readonly body?: string;
  readonly signal?: AbortSignal;
  readonly [AGENT_TRANSPORT_INIT_BRAND]: true;
}

export interface AgentTransportRequest {
  readonly baseUrl: string;
  readonly credential: CredentialSnapshot;
  readonly target: AgentRequestTarget;
  readonly init: AgentTransportInit;
}

export interface AgentTransport {
  request(request: AgentTransportRequest): Promise<Response>;
}

export class AgentTransportConfigurationError extends Error {
  readonly kind = "configuration_invalid" as const;

  constructor(message = "The Agent transport configuration is invalid") {
    super(message);
    this.name = "AgentTransportConfigurationError";
  }
}

export class AgentTransportUpstreamUnavailableError extends Error {
  readonly kind = "upstream_unavailable" as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AgentTransportUpstreamUnavailableError";
  }
}

/**
 * Converts the public JSON request shape into the replay-safe internal transport
 * shape. A stateful `toJSON` is therefore evaluated exactly once, before any send.
 */
export function prepareAgentTransportInit(init?: AgentRequestInit): AgentTransportInit {
  try {
    if (init !== undefined && (init === null || typeof init !== "object" || Array.isArray(init))) {
      throw configurationError();
    }

    const method = init?.method ?? "GET";
    if (method !== "GET" && method !== "POST") {
      throw configurationError();
    }

    const jsonBody =
      init !== undefined && Object.prototype.hasOwnProperty.call(init, "jsonBody")
        ? init.jsonBody
        : undefined;
    const hasJsonBody = jsonBody !== undefined;
    if (method === "GET" && hasJsonBody) {
      throw configurationError();
    }

    let body: string | undefined;
    if (hasJsonBody) {
      body = JSON.stringify(jsonBody);
      if (body === undefined) {
        throw configurationError();
      }
    }

    const signal = init?.signal;
    if (signal !== undefined && !isAbortSignal(signal)) {
      throw configurationError();
    }

    const prepared = {
      method,
      ...(body === undefined ? {} : { body }),
      ...(signal === undefined ? {} : { signal }),
    };
    Object.defineProperty(prepared, AGENT_TRANSPORT_INIT_BRAND, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    const frozen = Object.freeze(prepared) as AgentTransportInit;
    PREPARED_AGENT_TRANSPORT_INITS.add(frozen);
    return frozen;
  } catch (error) {
    if (error instanceof AgentTransportConfigurationError) {
      throw error;
    }
    throw configurationError();
  }
}

class DefaultAgentTransport implements AgentTransport {
  readonly #fetch: AgentTransportFetch;
  readonly #resolveHostname: HostnameResolver;
  readonly #allowInsecureHttp: boolean;
  readonly #allowlistedHostnames: ReadonlySet<string>;

  constructor(options: CreateAgentTransportOptions) {
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#resolveHostname = options.resolveHostname ?? defaultHostnameResolver;
    this.#allowInsecureHttp = options.policy?.allowInsecureHttp === true;
    this.#allowlistedHostnames = new Set(
      (options.policy?.allowlistedHostnames ?? []).map(normalizeHostname),
    );
  }

  async request(request: AgentTransportRequest): Promise<Response> {
    const prepared = prepareRequest(
      request,
      this.#allowInsecureHttp,
      this.#allowlistedHostnames,
    );
    await this.#enforceAddressPolicy(prepared.hostname);

    try {
      return await this.#fetch(prepared.url, prepared.init);
    } catch (error) {
      if (isAbortError(error) || isExactAbortReason(error, prepared.init.signal)) {
        throw error;
      }
      throw new AgentTransportUpstreamUnavailableError("The Agent is unavailable", error);
    }
  }

  async #enforceAddressPolicy(hostname: string): Promise<void> {
    const normalizedHostname = normalizeHostname(hostname);
    if (this.#allowlistedHostnames.has(normalizedHostname)) {
      return;
    }
    if (METADATA_HOSTNAMES.has(normalizedHostname)) {
      throw configurationError();
    }

    const literalVersion = isIP(normalizedHostname);
    if (literalVersion === 4 || literalVersion === 6) {
      if (!isPublicAddress(normalizedHostname, literalVersion)) {
        throw configurationError();
      }
      return;
    }

    let addresses: readonly string[];
    try {
      addresses = await this.#resolveHostname(normalizedHostname);
    } catch (error) {
      throw new AgentTransportUpstreamUnavailableError(
        "The Agent hostname could not be resolved",
        error,
      );
    }

    if (!Array.isArray(addresses) || addresses.length === 0) {
      throw new AgentTransportUpstreamUnavailableError(
        "The Agent hostname could not be resolved",
      );
    }

    for (const address of addresses) {
      const version = typeof address === "string" ? isIP(address) : 0;
      if (version !== 4 && version !== 6) {
        throw new AgentTransportUpstreamUnavailableError(
          "The Agent hostname could not be resolved",
        );
      }
      if (!isPublicAddress(address, version)) {
        throw configurationError();
      }
    }

    // This is a point-in-time DNS check, not a binding between the vetted answer
    // and fetch's socket. Production still requires network-layer egress controls
    // to contain DNS rebinding/TOCTOU and fetches performed inside other libraries.
  }
}

interface PreparedRequest {
  readonly hostname: string;
  readonly url: URL;
  readonly init: RequestInit;
}

export function createAgentTransport(
  options: CreateAgentTransportOptions = {},
): AgentTransport {
  return new DefaultAgentTransport(options);
}

async function defaultHostnameResolver(hostname: string): Promise<readonly string[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address }) => address);
}

function prepareRequest(
  request: AgentTransportRequest,
  allowInsecureHttp: boolean,
  allowlistedHostnames: ReadonlySet<string>,
): PreparedRequest {
  try {
    const preparedInit = request.init;
    assertAgentTransportInit(preparedInit);

    const baseUrl = request.baseUrl;
    const credential = request.credential;
    const target = request.target;
    if (target === null || typeof target !== "object" || Array.isArray(target)) {
      throw configurationError();
    }
    const pathname = target.pathname;
    const searchParams = target.searchParams;

    const url = parseBaseUrl(baseUrl, allowInsecureHttp, allowlistedHostnames);
    validatePathname(pathname);

    const { method, body, signal } = preparedInit;
    const headers = new Headers();
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }

    // Credentials are deliberately materialized after all business headers/body.
    materializeCredential(headers, credential);

    url.pathname = joinDeploymentPath(url.pathname, pathname);
    applySearchParams(url, searchParams);

    const init: RequestInit = {
      method,
      headers,
      redirect: "manual",
    };
    if (body !== undefined) {
      init.body = body;
    }
    if (signal !== undefined) {
      init.signal = signal;
    }

    return { hostname: url.hostname, url, init };
  } catch (error) {
    if (error instanceof AgentTransportConfigurationError) {
      throw error;
    }
    throw configurationError();
  }
}

function assertAgentTransportInit(value: unknown): asserts value is AgentTransportInit {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !PREPARED_AGENT_TRANSPORT_INITS.has(value)
  ) {
    throw configurationError();
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<AbortSignal>;
  return (
    typeof candidate.aborted === "boolean" &&
    typeof candidate.addEventListener === "function" &&
    typeof candidate.removeEventListener === "function"
  );
}

function parseBaseUrl(
  baseUrl: string,
  allowInsecureHttp: boolean,
  allowlistedHostnames: ReadonlySet<string>,
): URL {
  if (
    typeof baseUrl !== "string" ||
    RAW_CONTROL.test(baseUrl) ||
    baseUrl.includes("\\") ||
    !/^https?:\/\//i.test(baseUrl)
  ) {
    throw configurationError();
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw configurationError();
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw configurationError();
  }
  if (
    url.protocol === "http:" &&
    (!allowInsecureHttp || !allowlistedHostnames.has(normalizeHostname(url.hostname)))
  ) {
    throw configurationError();
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    baseUrl.includes("?") ||
    baseUrl.includes("#") ||
    url.hostname === ""
  ) {
    throw configurationError();
  }

  return url;
}

function validatePathname(pathname: string): void {
  if (
    typeof pathname !== "string" ||
    !pathname.startsWith("/") ||
    pathname.startsWith("//")
  ) {
    throw configurationError();
  }

  let decoded = pathname;
  for (let pass = 0; pass <= MAX_PATH_DECODE_PASSES; pass += 1) {
    validateDecodedPath(decoded);
    if (!decoded.includes("%")) {
      return;
    }
    if (pass === MAX_PATH_DECODE_PASSES) {
      throw configurationError();
    }

    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      throw configurationError();
    }
  }
}

function validateDecodedPath(pathname: string): void {
  if (
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    pathname.includes("?") ||
    pathname.includes("#") ||
    pathname.includes("\\") ||
    RAW_CONTROL.test(pathname) ||
    pathname.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw configurationError();
  }
}

function joinDeploymentPath(basePathname: string, pathname: string): string {
  const deploymentPrefix = basePathname === "/" ? "" : basePathname.replace(/\/+$/, "");
  return `${deploymentPrefix}${pathname}`;
}

function applySearchParams(
  url: URL,
  searchParams: Readonly<Record<string, string>> | undefined,
): void {
  if (searchParams === undefined) {
    return;
  }
  if (searchParams === null || typeof searchParams !== "object" || Array.isArray(searchParams)) {
    throw configurationError();
  }

  for (const [name, value] of Object.entries(searchParams)) {
    if (typeof value !== "string") {
      throw configurationError();
    }
    url.searchParams.set(name, value);
  }
}

function materializeCredential(headers: Headers, credential: CredentialSnapshot): void {
  if (credential === null || typeof credential !== "object") {
    throw configurationError();
  }

  switch (credential.kind) {
    case "none":
      return;
    case "basic": {
      if (typeof credential.username !== "string" || typeof credential.password !== "string") {
        throw configurationError();
      }
      const encoded = Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString(
        "base64",
      );
      headers.set("authorization", `Basic ${encoded}`);
      return;
    }
    case "bearer": {
      if (typeof credential.token !== "string" || /[\r\n]/.test(credential.token)) {
        throw configurationError();
      }
      const token = credential.token.trim();
      if (token === "") {
        throw configurationError();
      }
      headers.set("authorization", `Bearer ${token}`);
      return;
    }
    case "headers":
      materializeConfiguredHeaders(headers, credential.headers);
      return;
    default:
      throw configurationError();
  }
}

function materializeConfiguredHeaders(
  destination: Headers,
  configuredHeaders: Readonly<Record<string, string>>,
): void {
  if (
    configuredHeaders === null ||
    typeof configuredHeaders !== "object" ||
    Array.isArray(configuredHeaders)
  ) {
    throw configurationError();
  }

  const seenNames = new Set<string>();
  for (const [name, value] of Object.entries(configuredHeaders)) {
    const normalizedName = name.toLowerCase();
    if (
      !HTTP_FIELD_NAME.test(name) ||
      seenNames.has(normalizedName) ||
      isReservedHeaderName(normalizedName) ||
      typeof value !== "string" ||
      /[\r\n]/.test(value)
    ) {
      throw configurationError();
    }
    seenNames.add(normalizedName);
    destination.set(name, value);
  }
}

function isReservedHeaderName(normalizedName: string): boolean {
  return (
    RESERVED_HEADER_NAMES.has(normalizedName) ||
    normalizedName === "proxy" ||
    normalizedName.startsWith("proxy-") ||
    normalizedName.startsWith("x-forwarded-")
  );
}

function normalizeHostname(hostname: string): string {
  let normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.replace(/\.$/, "");
}

function isPublicAddress(address: string, version: 4 | 6): boolean {
  return version === 4 ? isPublicIPv4(address) : isPublicIPv6(address);
}

function isPublicIPv4(address: string): boolean {
  const value = parseIPv4(address);
  if (value === undefined) {
    return false;
  }

  return !NON_PUBLIC_IPV4_RANGES.some(([network, prefix]) =>
    isInIPv4Cidr(value, network, prefix),
  );
}

const NON_PUBLIC_IPV4_RANGES: readonly (readonly [number, number])[] = [
  [ipv4Number(0, 0, 0, 0), 8],
  [ipv4Number(10, 0, 0, 0), 8],
  [ipv4Number(100, 64, 0, 0), 10],
  [ipv4Number(127, 0, 0, 0), 8],
  [ipv4Number(169, 254, 0, 0), 16],
  [ipv4Number(172, 16, 0, 0), 12],
  [ipv4Number(192, 0, 0, 0), 24],
  [ipv4Number(192, 0, 2, 0), 24],
  [ipv4Number(192, 88, 99, 0), 24],
  [ipv4Number(192, 168, 0, 0), 16],
  [ipv4Number(192, 175, 48, 0), 24],
  [ipv4Number(198, 18, 0, 0), 15],
  [ipv4Number(198, 51, 100, 0), 24],
  [ipv4Number(203, 0, 113, 0), 24],
  [ipv4Number(224, 0, 0, 0), 4],
  [ipv4Number(240, 0, 0, 0), 4],
];

function parseIPv4(address: string): number | undefined {
  const octets = address.split(".");
  if (octets.length !== 4) {
    return undefined;
  }
  const parsed = octets.map((octet) => Number(octet));
  if (parsed.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return undefined;
  }
  return ipv4Number(parsed[0]!, parsed[1]!, parsed[2]!, parsed[3]!);
}

function ipv4Number(a: number, b: number, c: number, d: number): number {
  return a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8 + d;
}

function isInIPv4Cidr(value: number, network: number, prefix: number): boolean {
  const blockSize = 2 ** (32 - prefix);
  return Math.floor(value / blockSize) === Math.floor(network / blockSize);
}

function isPublicIPv6(address: string): boolean {
  const value = parseIPv6(address);
  if (value === undefined) {
    return false;
  }

  // IPv4-mapped IPv6 must inherit the IPv4 decision rather than bypass it.
  if (value >> 32n === 0xffffn) {
    return isPublicIPv4(
      `${Number((value >> 24n) & 0xffn)}.${Number((value >> 16n) & 0xffn)}.${Number(
        (value >> 8n) & 0xffn,
      )}.${Number(value & 0xffn)}`,
    );
  }

  // Only global unicast 2000::/3 is eligible. Explicit exclusions below cover
  // special-use allocations that sit inside that broad range.
  if (!isInIPv6Cidr(value, parseIPv6("2000::")!, 3)) {
    return false;
  }
  return !NON_PUBLIC_IPV6_RANGES.some(([network, prefix]) =>
    isInIPv6Cidr(value, network, prefix),
  );
}

const NON_PUBLIC_IPV6_RANGES: readonly (readonly [bigint, number])[] = [
  [parseIPv6("2001::")!, 23],
  [parseIPv6("2001:db8::")!, 32],
  [parseIPv6("2002::")!, 16],
  [parseIPv6("3fff::")!, 20],
];

function parseIPv6(address: string): bigint | undefined {
  let normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4 = parseIPv4(normalized.slice(lastColon + 1));
    if (lastColon < 0 || ipv4 === undefined) {
      return undefined;
    }
    normalized = `${normalized.slice(0, lastColon)}:${(ipv4 >>> 16).toString(16)}:${(
      ipv4 & 0xffff
    ).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]!.split(":");
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) {
    return undefined;
  }

  const pieces = [...left, ...Array.from({ length: omitted }, () => "0"), ...right];
  if (pieces.length !== 8 || pieces.some((piece) => !/^[0-9a-f]{1,4}$/.test(piece))) {
    return undefined;
  }

  return pieces.reduce((value, piece) => (value << 16n) | BigInt(`0x${piece}`), 0n);
}

function isInIPv6Cidr(value: bigint, network: bigint, prefix: number): boolean {
  return value >> BigInt(128 - prefix) === network >> BigInt(128 - prefix);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

function isExactAbortReason(error: unknown, signal: AbortSignal | null | undefined): boolean {
  return signal?.aborted === true && Object.is(error, signal.reason);
}

function configurationError(): AgentTransportConfigurationError {
  return new AgentTransportConfigurationError();
}
