import { describe, expect, it } from "vitest";

import {
  authMethodCatalog,
  builtInAuthMethodCatalog,
  getAuthMethodFormDescriptor,
  getAuthMethodRegistration,
  listAuthMethodFormDescriptors,
  listAuthMethodRegistrations,
} from "@/agent-auth";
import { UnknownAuthMethodError } from "@/agent-auth/catalog";

describe("built-in auth method catalog and form descriptors", () => {
  it("registers only the four connection-scoped static methods", () => {
    expect(authMethodCatalog).toBe(builtInAuthMethodCatalog);
    expect(listAuthMethodRegistrations().map(({ method }) => method)).toEqual([
      "none",
      "basic",
      "bearer",
      "headers",
    ]);
    expect(
      listAuthMethodRegistrations().map(({ credentialScope }) => credentialScope),
    ).toEqual(["connection", "connection", "connection", "connection"]);
    expect(getAuthMethodRegistration("basic").provider.method).toBe("basic");
    expect(Object.isFrozen(listAuthMethodRegistrations())).toBe(true);
    expect(() => getAuthMethodRegistration("oidc-authorization-code")).toThrowError(
      UnknownAuthMethodError,
    );
  });

  it("publishes serializable, noninteractive field metadata without server objects", () => {
    const descriptors = listAuthMethodFormDescriptors();

    expect(descriptors).toEqual([
      {
        method: "none",
        label: "No authentication",
        interactive: false,
        fields: [],
      },
      {
        method: "basic",
        label: "HTTP Basic",
        interactive: false,
        fields: [
          {
            name: "username",
            label: "Username",
            type: "text",
            required: true,
            autocomplete: "username",
          },
          {
            name: "password",
            label: "Password",
            type: "secret",
            required: true,
            autocomplete: "current-password",
          },
        ],
      },
      {
        method: "bearer",
        label: "Bearer token",
        interactive: false,
        fields: [
          {
            name: "token",
            label: "Token",
            type: "secret",
            required: true,
            autocomplete: "off",
          },
        ],
      },
      {
        method: "headers",
        label: "Custom headers",
        interactive: false,
        fields: [
          {
            name: "headers",
            label: "Headers",
            type: "key-value",
            required: true,
            keyLabel: "Header name",
            valueLabel: "Header value",
          },
        ],
      },
    ]);

    const roundtripped = JSON.parse(JSON.stringify(descriptors));
    expect(roundtripped).toEqual(descriptors);
    expect(containsServerObject(roundtripped)).toBe(false);
    expect(getAuthMethodFormDescriptor("headers")).toBe(descriptors[3]);
    expect(Object.isFrozen(descriptors)).toBe(true);
    expect(descriptors.every((descriptor) => Object.isFrozen(descriptor))).toBe(true);
    expect(descriptors.every((descriptor) => Object.isFrozen(descriptor.fields))).toBe(true);
    expect(() => getAuthMethodFormDescriptor("missing")).toThrowError(UnknownAuthMethodError);
  });
});

function containsServerObject(value: unknown): boolean {
  if (typeof value === "function") {
    return true;
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  if ("provider" in value || "configSchema" in value) {
    return true;
  }
  return Object.values(value).some(containsServerObject);
}
