import { expect, test } from "vitest";
import { projectAiModel } from "./project-ai-policy.ts";

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
