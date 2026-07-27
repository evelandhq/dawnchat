import { describe, expect, it, vi } from "vitest";

import { createEvelandIdentityClient } from "@/identity/client";

describe("Eveland browser identity client", () => {
  it("keeps Caller Tokens only in memory and refreshes shortly before expiry", async () => {
    let now = 1_785_000_000_000;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          authenticated: true,
          principal: { id: "ipr_1", name: "Test User", email: null },
          activeRealm: { id: "irl_1", name: "Account 1" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          token: "caller-token-1",
          expiresAt: new Date(now + 60_000).toISOString(),
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          token: "caller-token-2",
          expiresAt: new Date(now + 120_000).toISOString(),
        }),
      );
    const client = createEvelandIdentityClient({
      baseUrl: "https://eveland.example.com",
      returnTarget: "eve-chats",
      fetch,
      now: () => new Date(now),
      redirect: vi.fn(),
    });

    await expect(client.getCallerToken("project_support", "/agents/agent_1")).resolves.toBe(
      "caller-token-1",
    );
    await expect(client.getCallerToken("project_support", "/agents/agent_1")).resolves.toBe(
      "caller-token-1",
    );
    expect(fetch).toHaveBeenCalledTimes(2);

    now += 50_000;
    await expect(client.getCallerToken("project_support", "/agents/agent_1")).resolves.toBe(
      "caller-token-2",
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("shares one in-flight Caller Token request per project", async () => {
    const now = 1_785_000_000_000;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          authenticated: true,
          principal: { id: "ipr_1", name: "Test User", email: null },
          activeRealm: { id: "irl_1", name: "Account 1" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          token: "caller-token",
          expiresAt: new Date(now + 60_000).toISOString(),
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          token: "duplicate-token",
          expiresAt: new Date(now + 60_000).toISOString(),
        }),
      );
    const client = createEvelandIdentityClient({
      baseUrl: "https://eveland.example.com",
      returnTarget: "eve-chats",
      fetch,
      now: () => new Date(now),
      redirect: vi.fn(),
    });

    await expect(
      Promise.all([
        client.getCallerToken("project_support", "/agents/agent_1"),
        client.getCallerToken("project_support", "/agents/agent_1"),
      ]),
    ).resolves.toEqual(["caller-token", "caller-token"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("redirects unauthenticated users through the provider-neutral login endpoint", async () => {
    const redirect = vi.fn();
    const client = createEvelandIdentityClient({
      baseUrl: "https://eveland.example.com/",
      returnTarget: "eve-chats",
      fetch: vi.fn(async () => Response.json({ authenticated: false })),
      redirect,
    });

    await expect(
      client.getCallerToken("project_support", "/agents/agent_1?from=home"),
    ).rejects.toMatchObject({ code: "identity_redirecting" });
    expect(redirect).toHaveBeenCalledWith(
      "https://eveland.example.com/identity/login?target=eve-chats&returnPath=%2Fagents%2Fagent_1%3Ffrom%3Dhome",
    );
  });

  it("surfaces a project grant denial without starting another login", async () => {
    const redirect = vi.fn();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          authenticated: true,
          principal: { id: "ipr_1", name: "Test User", email: null },
          activeRealm: { id: "irl_1", name: "Account 1" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            code: "identity_project_forbidden",
            error: "The current identity scope cannot use this Agent.",
          },
          { status: 403 },
        ),
      );
    const client = createEvelandIdentityClient({
      baseUrl: "https://eveland.example.com",
      returnTarget: "eve-chats",
      fetch,
      redirect,
    });

    await expect(
      client.getCallerToken("project_support", "/agents/agent_1"),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "identity_project_forbidden",
        status: 403,
      }),
    );
    expect(redirect).not.toHaveBeenCalled();
  });
});
