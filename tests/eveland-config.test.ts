import { describe, expect, it } from "vitest";

import { resolveEvelandConfig } from "@/identity/config";

describe("Eveland configuration", () => {
  it("defaults every network hop to Eveland's single public frontdoor", () => {
    expect(resolveEvelandConfig({})).toEqual({
      publicOrigin: "http://localhost:17300",
      issuer: "http://localhost:17300",
      internalOrigin: "http://localhost:17300",
      jwksUrl: "http://localhost:17300/.well-known/jwks.json",
      returnTarget: "eve-chats",
    });
  });

  it("keeps a stable token issuer separate from public and internal routing", () => {
    expect(
      resolveEvelandConfig({
        EVELAND_PUBLIC_ORIGIN: "https://eveland.example.com/",
        EVELAND_IDENTITY_ISSUER: "https://stable-issuer.example.com/",
        EVELAND_INTERNAL_ORIGIN: "http://eveland-frontdoor:17300/",
        EVELAND_IDENTITY_RETURN_TARGET: "dawn-production",
      }),
    ).toEqual({
      publicOrigin: "https://eveland.example.com",
      issuer: "https://stable-issuer.example.com",
      internalOrigin: "http://eveland-frontdoor:17300",
      jwksUrl: "http://eveland-frontdoor:17300/.well-known/jwks.json",
      returnTarget: "dawn-production",
    });
  });

  it("allows an explicit JWKS endpoint without changing the token issuer", () => {
    expect(
      resolveEvelandConfig({
        EVELAND_PUBLIC_ORIGIN: "https://eveland.example.com",
        EVELAND_IDENTITY_ISSUER: "https://stable-issuer.example.com",
        EVELAND_IDENTITY_JWKS_URL: "http://eveland-api:17400/keys",
      }),
    ).toMatchObject({
      issuer: "https://stable-issuer.example.com",
      jwksUrl: "http://eveland-api:17400/keys",
    });
  });

  it("accepts the previous Dawn variable names during a rolling upgrade", () => {
    expect(
      resolveEvelandConfig({
        NEXT_PUBLIC_EVELAND_IDENTITY_URL: "https://legacy-public.example.com",
        NEXT_PUBLIC_EVELAND_IDENTITY_RETURN_TARGET: "legacy-dawn",
        EVELAND_IDENTITY_URL: "http://legacy-internal:4000",
      }),
    ).toMatchObject({
      publicOrigin: "https://legacy-public.example.com",
      issuer: "https://legacy-public.example.com",
      internalOrigin: "http://legacy-internal:4000",
      returnTarget: "legacy-dawn",
    });
  });
});
