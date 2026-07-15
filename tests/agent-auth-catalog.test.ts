import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AuthMethodCatalog, UnknownAuthMethodError } from "@/agent-auth/catalog";
import type {
  AuthMethodCatalogEntry,
  AuthMethodFormDescriptor,
  AuthMethodRegistration,
  CredentialProvider,
} from "@/agent-auth/contracts";

function provider(method: string): CredentialProvider {
  return {
    method,
    async getCredential() {
      return {
        ok: true,
        credential: { kind: "none" },
        version: { securityRevision: 1, rotationSeq: null },
      };
    },
    async inspect() {
      return { state: "not_required" };
    },
    async recoverUnauthorized() {
      return {
        action: "give_up",
        failure: { code: "credential_rejected", message: "rejected" },
      };
    },
  };
}

function entry(
  method = "example",
  options: {
    key?: string;
    providerMethod?: string;
    descriptorMethod?: string;
    interactive?: boolean;
    authorizePath?: string;
  } = {},
): AuthMethodCatalogEntry {
  const registration: AuthMethodRegistration = {
    method,
    credentialScope: "connection",
    configSchema: z.object({}).strict(),
    provider: provider(options.providerMethod ?? method),
    ...(options.authorizePath === undefined
      ? {}
      : { interaction: { authorizePath: options.authorizePath } }),
  };
  const descriptor: AuthMethodFormDescriptor = {
    method: options.descriptorMethod ?? method,
    label: "Example",
    interactive: options.interactive ?? false,
    fields: [],
  };

  return { key: options.key ?? method, registration, descriptor };
}

describe("AuthMethodCatalog", () => {
  it("offers immutable registration and descriptor lookup/list views", () => {
    const catalog = new AuthMethodCatalog([entry()]);

    const registration = catalog.getRegistration("example");
    const descriptor = catalog.getDescriptor("example");
    const registrations = catalog.listRegistrations();
    const descriptors = catalog.listDescriptors();

    expect(registration.method).toBe("example");
    expect(descriptor).toEqual({
      method: "example",
      label: "Example",
      interactive: false,
      fields: [],
    });
    expect(registrations).toEqual([registration]);
    expect(descriptors).toEqual([descriptor]);
    expect(Object.isFrozen(registration)).toBe(true);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.fields)).toBe(true);
    expect(Object.isFrozen(registrations)).toBe(true);
    expect(Object.isFrozen(descriptors)).toBe(true);
  });

  it("fails closed for unknown methods", () => {
    const catalog = new AuthMethodCatalog([entry()]);

    expect(() => catalog.getRegistration("missing")).toThrowError(UnknownAuthMethodError);
    expect(() => catalog.getRegistration("missing")).toThrowError("Unknown auth method: missing");
    expect(() => catalog.getDescriptor("missing")).toThrowError(UnknownAuthMethodError);
  });

  it.each([
    ["registration key", entry("example", { key: "other" })],
    ["provider method", entry("example", { providerMethod: "other" })],
    ["descriptor method", entry("example", { descriptorMethod: "other" })],
  ])("rejects a mismatched %s", (_label, invalidEntry) => {
    expect(() => new AuthMethodCatalog([invalidEntry])).toThrowError(/must match/);
  });

  it("rejects duplicate methods", () => {
    expect(() => new AuthMethodCatalog([entry(), entry()])).toThrowError(
      "Duplicate auth method: example",
    );
  });

  it("requires an authorize path exactly for interactive descriptors", () => {
    expect(
      () => new AuthMethodCatalog([entry("interactive", { interactive: true })]),
    ).toThrowError(/requires an interaction authorizePath/);
    expect(
      () =>
        new AuthMethodCatalog([
          entry("static", { interactive: false, authorizePath: "/auth/static/authorize" }),
        ]),
    ).toThrowError(/must not declare interaction/);

    expect(
      () =>
        new AuthMethodCatalog([
          entry("interactive", {
            interactive: true,
            authorizePath: "/auth/oidc/authorize",
          }),
        ]),
    ).not.toThrow();
  });

  it.each([
    "auth/authorize",
    "//evil.example/authorize",
    "https://evil.example/authorize",
    "/auth/authorize?next=/chats/1",
    "/auth/authorize#fragment",
    "/auth\\authorize",
    "/auth/../authorize",
    "/auth/./authorize",
    "/auth/%2e%2e/authorize",
    "/auth/%2E./authorize",
    "/auth/%252e%252e/authorize",
    "/auth/%authorize",
    "/auth/%5cauthorize",
    "/auth/%255cauthorize",
    "/auth/%00authorize",
    "/auth/%2500authorize",
    "/auth/%c2%85authorize",
    "/auth/%3fauthorize",
    "/auth/%2523authorize",
  ])("rejects unsafe authorize path %s", (authorizePath) => {
    expect(
      () =>
        new AuthMethodCatalog([
          entry("interactive", { interactive: true, authorizePath }),
        ]),
    ).toThrowError(/Invalid authorizePath/);
  });

  it.each([
    "/auth%2fauthorize",
    "/auth/%2Fauthorize",
    "/auth/%252fauthorize",
  ])("rejects an encoded path separator in authorize path %s", (authorizePath) => {
    expect(
      () =>
        new AuthMethodCatalog([
          entry("interactive", { interactive: true, authorizePath }),
        ]),
    ).toThrowError(/Invalid authorizePath/);
  });
});
