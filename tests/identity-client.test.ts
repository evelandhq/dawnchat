import { describe, expect, it, vi } from "vitest";

import { createEvelandIdentityClient } from "@/identity/client";

describe("Eveland browser identity client", () => {
  it("reports login as available when the login route answers with a redirect", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://localhost:3000/login" } }));
    const client = createEvelandIdentityClient({
      baseUrl: "http://localhost:4000",
      returnTarget: "eve-chats",
      fetch,
      redirect: vi.fn(),
    });

    await expect(client.getLoginAvailability("/chats/chat_1")).resolves.toEqual({
      available: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:4000/identity/login?target=eve-chats&returnPath=%2Fchats%2Fchat_1",
      expect.objectContaining({ credentials: "include", redirect: "manual" }),
    );
  });

  it("reports the refusal code of an open-access instance", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      Response.json(
        {
          code: "identity_login_not_required",
          error: "This Eveland instance is open to all callers; no identity login is used.",
        },
        { status: 503 },
      ),
    );
    const client = createEvelandIdentityClient({
      baseUrl: "http://localhost:4000",
      returnTarget: "eve-chats",
      fetch,
      redirect: vi.fn(),
    });

    await expect(client.getLoginAvailability("/")).resolves.toEqual({
      available: false,
      code: "identity_login_not_required",
      message: "This Eveland instance is open to all callers; no identity login is used.",
    });
  });

  it("treats an unreachable Identity as unavailable, not as open access", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    const client = createEvelandIdentityClient({
      baseUrl: "http://localhost:4000",
      returnTarget: "eve-chats",
      fetch,
      redirect: vi.fn(),
    });

    await expect(client.getLoginAvailability("/")).rejects.toMatchObject({
      code: "identity_unavailable",
    });
  });


  it("uses a same-origin proxy for cookie-bearing Identity requests without changing login ownership", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
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
        Response.json({ token: "caller-token", expiresAt }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const redirect = vi.fn();
    const client = createEvelandIdentityClient({
      baseUrl: "http://localhost:4000",
      returnTarget: "eve-chats",
      fetch,
      redirect,
    });

    await expect(client.getSession()).resolves.toMatchObject({
      authenticated: true,
    });
    await expect(
      client.getCallerToken("project_support", "/chats/chat_1"),
    ).resolves.toBe("caller-token");
    await expect(client.logout()).resolves.toBeUndefined();

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/identity/session",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/identity/caller-tokens",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "/identity/logout",
      expect.objectContaining({ credentials: "include" }),
    );

    expect(() => client.login("/chats/chat_1")).toThrow(
      expect.objectContaining({ code: "identity_redirecting" }),
    );
    expect(redirect).toHaveBeenCalledWith(
      "http://localhost:4000/identity/login?target=eve-chats&returnPath=%2Fchats%2Fchat_1",
    );
  });

  it("loads the Realm catalog and an app-scoped token from Eveland Identity", async () => {
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          agents: [
            {
              projectId: "project_support",
              name: "Support",
              description: "Answers support questions.",
              url: "https://support.agents.example.com",
              capabilities: { eveChat: true },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          authenticated: true,
          principal: { id: "ipr_1", name: "Test User", email: null },
          activeRealm: { id: "irl_1", name: "Account 1" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ token: "app-token", expiresAt }),
      );
    const client = createEvelandIdentityClient({
      baseUrl: "https://eveland.example.com",
      returnTarget: "eve-chats",
      fetch,
      redirect: vi.fn(),
    });

    await expect(client.getCatalog()).resolves.toEqual({
      issuer: "https://eveland.example.com",
      agents: [
        {
          projectId: "project_support",
          name: "Support",
          description: "Answers support questions.",
          url: "https://support.agents.example.com",
          capabilities: { eveChat: true },
        },
      ],
    });
    await expect(client.getAppToken()).resolves.toBe("app-token");
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://eveland.example.com/agent-catalog",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "https://eveland.example.com/identity/app-tokens",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ target: "eve-chats" }),
      }),
    );
  });

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

  it("consumes an Eveland route challenge and silently obtains a Caller Token", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
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
        Response.json({ token: "caller-token", expiresAt }),
      );
    const redirect = vi.fn();
    const client = createEvelandIdentityClient({
      baseUrl: "https://eveland.example.com",
      returnTarget: "eve-chats",
      fetch,
      redirect,
    });
    const challenge =
      'Basic realm="agent", Bearer realm="eveland", authorization_uri="https://eveland.example.com/identity/login", project_id="project_support", display_name="Eveland"';

    await expect(
      client.respondToAuthenticationChallenge(
        challenge,
        "project_support",
        "/chats/chat_1",
      ),
    ).resolves.toBe("caller-token");

    expect(redirect).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenLastCalledWith(
      "https://eveland.example.com/identity/caller-tokens",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ projectId: "project_support" }),
      }),
    );
  });

  it("uses the Agent-provided Eveland continuation URL for top-level login", async () => {
    const redirect = vi.fn();
    const client = createEvelandIdentityClient({
      baseUrl: "https://eveland.example.com",
      returnTarget: "eve-chats",
      fetch: vi.fn(async () => Response.json({ authenticated: false })),
      redirect,
    });
    const challenge =
      'Bearer realm="eveland", authorization_uri="https://eveland.example.com/identity/login", project_id="project_support", display_name="Eveland"';

    await expect(
      client.respondToAuthenticationChallenge(
        challenge,
        "project_support",
        "/chats/chat_1?retry=1",
      ),
    ).rejects.toMatchObject({ code: "identity_redirecting" });
    expect(redirect).toHaveBeenCalledWith(
      "https://eveland.example.com/identity/login?target=eve-chats&returnPath=%2Fchats%2Fchat_1%3Fretry%3D1",
    );
  });

  it("starts only one login navigation while a slow browser is still redirecting", async () => {
    const redirect = vi.fn();
    const client = createEvelandIdentityClient({
      baseUrl: "https://eveland.example.com",
      returnTarget: "eve-chats",
      fetch: vi.fn(async () => Response.json({ authenticated: false })),
      redirect,
    });
    const challenge =
      'Bearer realm="eveland", authorization_uri="https://eveland.example.com/identity/login", project_id="project_support", display_name="Eveland"';

    await expect(
      client.respondToAuthenticationChallenge(
        challenge,
        "project_support",
        "/chats/chat_1",
      ),
    ).rejects.toMatchObject({ code: "identity_redirecting" });
    await expect(
      client.respondToAuthenticationChallenge(
        challenge,
        "project_support",
        "/chats/chat_1",
      ),
    ).rejects.toMatchObject({ code: "identity_redirecting" });

    expect(redirect).toHaveBeenCalledOnce();
  });

  it("ignores non-Eveland challenges and rejects substituted continuation metadata", async () => {
    const fetch = vi.fn();
    const redirect = vi.fn();
    const client = createEvelandIdentityClient({
      baseUrl: "https://eveland.example.com",
      returnTarget: "eve-chats",
      fetch,
      redirect,
    });

    await expect(
      client.respondToAuthenticationChallenge(
        'Basic realm="agent"',
        "project_support",
        "/",
      ),
    ).resolves.toBeNull();
    await expect(
      client.respondToAuthenticationChallenge(
        'Bearer realm="eveland", authorization_uri="https://attacker.example.com/identity/login", project_id="project_support", display_name="Eveland"',
        "project_support",
        "/",
      ),
    ).rejects.toMatchObject({ code: "identity_challenge_invalid" });
    expect(fetch).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
});
