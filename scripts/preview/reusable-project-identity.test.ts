import { describe, expect, test } from "vitest";
import {
  resolveReusableAdminProjectGeneration,
  reusableAdminProjectIdentity,
} from "../../specs/test-support/reusable-project-identity.ts";

describe("reusableAdminProjectIdentity", () => {
  test("converges within one generation and rotates between generations", () => {
    const first = reusableAdminProjectIdentity({
      baseUrl: "https://os.iterate-preview-5.com/path",
      family: "agent-chat",
      generation: "workflow-1",
    });
    expect(
      reusableAdminProjectIdentity({
        baseUrl: "https://os.iterate-preview-5.com/another-path",
        family: "agent-chat",
        generation: "workflow-1",
      }),
    ).toEqual(first);

    const next = reusableAdminProjectIdentity({
      baseUrl: "https://os.iterate-preview-5.com",
      family: "agent-chat",
      generation: "workflow-2",
    });
    expect(next.id).not.toBe(first.id);
    expect(next.slug).not.toBe(first.slug);
  });

  test("prefers the explicit generation and otherwise scopes GitHub reruns by attempt", () => {
    expect(
      resolveReusableAdminProjectGeneration({
        PREVIEW_TEST_GENERATION: "marathon-generation",
        GITHUB_RUN_ID: "123",
      }),
    ).toBe("marathon-generation");
    expect(
      resolveReusableAdminProjectGeneration({
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_RUN_ID: "123",
      }),
    ).toBe("github-123-attempt-2");
  });
});
