import { describe, expect, test } from "vitest";
import type { EgressPolicy } from "./types.ts";
import { checkEgressPolicy } from "./policy-check.ts";

const basePolicy: EgressPolicy = {
  id: "egp_test",
  projectId: "prj_test",
  priority: 100,
  urlPattern: "url.hostname = 'gmail.googleapis.com'",
  method: null,
  headerMatch: null,
  decision: "human_approval",
  reason: "email_send",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe("checkEgressPolicy", () => {
  test("returns allow when no policies match", async () => {
    const result = await checkEgressPolicy(
      {
        method: "GET",
        url: "https://example.com/path",
        headers: {},
      },
      "prj_test",
      makeDb([]),
    );

    expect(result.decision).toBe("allow");
  });

  test("returns human_approval when policy matches", async () => {
    const result = await checkEgressPolicy(
      {
        method: "POST",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        headers: {},
        body: "hello",
      },
      "prj_test",
      makeDb([basePolicy]),
    );

    expect(result.decision).toBe("human_approval");
    expect(result.policy?.id).toBe(basePolicy.id);
  });
});

function makeDb(policies: EgressPolicy[]) {
  return {
    query: {
      egressPolicy: {
        findMany: async () => policies,
      },
    },
  } as unknown as Parameters<typeof checkEgressPolicy>[2];
}
