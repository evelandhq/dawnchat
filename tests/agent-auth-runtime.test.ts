import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getAgentAuthModule,
  resetAgentAuthModuleForTests,
} from "@/agent-auth/runtime.server";
import { setDbClientForTests } from "@/db/provider";
import { createRepository } from "@/db/repository";
import { createTestDbHandle, type TestDbHandle } from "@/test/db";

describe("server AgentAuthModule runtime composition", () => {
  let testDb: TestDbHandle;

  beforeEach(async () => {
    testDb = await createTestDbHandle();
    setDbClientForTests(testDb.db);
    resetAgentAuthModuleForTests();
  });

  afterEach(async () => {
    resetAgentAuthModuleForTests();
    setDbClientForTests(null);
    await testDb.close();
  });

  it("normalizes a missing connection without attempting transport", async () => {
    const result = await getAgentAuthModule().request(
      { agentConnectionId: "agent_missing", principalId: "" },
      { pathname: "/eve/v1/info" },
    );

    expect(result).toEqual({
      code: "configuration_invalid",
      method: "unknown",
      message: "The Agent authentication configuration is invalid",
    });
  });

  it("normalizes corrupt legacy auth config without leaking its stored diagnostic", async () => {
    const secretDiagnostic = "must-never-leak-from-corrupt-ciphertext";
    const connection = await createRepository(testDb.db).createAgentConnection({
      name: "Corrupt auth",
      baseUrl: "https://corrupt-auth.example.com",
      authType: "bearer",
      authConfigEncrypted: `eve-auth:v1:${secretDiagnostic}`,
    });

    const result = await getAgentAuthModule().request(
      { agentConnectionId: connection.id, principalId: "" },
      { pathname: "/eve/v1/info" },
    );

    expect(result).toEqual({
      code: "configuration_invalid",
      method: "bearer",
      message: "The Agent authentication configuration is invalid",
    });
    expect(JSON.stringify(result)).not.toContain(secretDiagnostic);
  });
});
