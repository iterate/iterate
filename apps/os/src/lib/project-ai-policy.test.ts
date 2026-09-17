import { expect, test } from "vitest";
import { projectAiModel, signupTestAiPolicy } from "./project-ai-policy.ts";

test("test projects intercept indirect agents and direct calls, with one exact live-agent exception", () => {
  const policy = { liveAgentPaths: ["/agents/bendy-yellow-fruit"] };
  for (const agentPath of [
    "/agents/mobile/note-123",
    "/agents/onboarding",
    "/agents/example-123",
    "/agents/slack/main/c0e2eslack/ts-123",
    undefined,
  ]) {
    expect(projectAiModel("openai/gpt-5.6-terra", policy, agentPath)).toBe(
      "intercepted/openai/gpt-5.6-terra",
    );
  }
  expect(projectAiModel("@cf/meta/llama-4-scout-17b-16e-instruct", policy, undefined)).toBe(
    "intercepted/@cf/meta/llama-4-scout-17b-16e-instruct",
  );
  expect(projectAiModel("intercepted/scripted", policy, undefined)).toBe("intercepted/scripted");
  expect(projectAiModel("openai/gpt-5.6-terra", policy, "/agents/bendy-yellow-fruit")).toBe(
    "openai/gpt-5.6-terra",
  );
  expect(projectAiModel("openai/gpt-5.6-terra", policy, "/agents/bendy-yellow-fruit-child")).toBe(
    "intercepted/openai/gpt-5.6-terra",
  );
});

test("ordinary project models are unchanged", () => {
  expect(projectAiModel("openai/gpt-5.6-terra", undefined, "/agents/mobile/note-123")).toBe(
    "openai/gpt-5.6-terra",
  );
});

test("automatic signup policy is restricted to the browser suite, never ordinary test logins or production", () => {
  expect(
    signupTestAiPolicy(
      "intercepted-e2e-notes-123+test@nustom.com",
      "ordinary-project",
      "preview-1",
    ),
  ).toEqual({
    liveAgentPaths: [],
  });
  expect(
    signupTestAiPolicy("intercepted-e2e-notes-123+test@nustom.com", "ordinary-project", "dev"),
  ).toEqual({
    liveAgentPaths: [],
  });
  expect(
    signupTestAiPolicy("alice+test@nustom.com", "ordinary-project", "preview-1"),
  ).toBeUndefined();
  expect(
    signupTestAiPolicy("intercepted-e2e-notes-123+test@nustom.com", "ordinary-project", "prd"),
  ).toBeUndefined();
  expect(
    signupTestAiPolicy("intercepted-e2e-notes-123+test@different.com", "ordinary-project", "dev"),
  ).toBeUndefined();
  expect(signupTestAiPolicy(undefined, "ordinary-project", "dev")).toBeUndefined();
});

test("the mobile fixture slug selects interception without an email claim", () => {
  expect(signupTestAiPolicy(undefined, "intercepted-e2e-mobile-notes-123", "preview_3")).toEqual({
    liveAgentPaths: [],
  });
  expect(signupTestAiPolicy(undefined, "intercepted-e2e-mobile-notes-123", "prd")).toBeUndefined();
  expect(signupTestAiPolicy(undefined, "mobile-notes-123", "preview_3")).toBeUndefined();
});
