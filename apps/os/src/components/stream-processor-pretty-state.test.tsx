// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { AgentPrettyState } from "./stream-processor-pretty-state.tsx";
import { AgentProcessorContract } from "~/domains/agents/agent-processor-contract.ts";

// A realistic v5 agent snapshot, built from the CONTRACT's own default fold so
// this test tracks the real state shape (the v4 renderer keyed off `context`
// / `currentRequest` / `publishedThrough` and silently fell back to raw JSON
// after the cutover).
function v5AgentState() {
  const base = AgentProcessorContract.stateSchema.parse({});
  return {
    ...base,
    birthCertificate: { createdAtOffset: 1 },
    config: { ...base.config, llm: { model: "openai/gpt-5.6-sol" } },
    lastLlmRequestOffset: 42,
    consecutiveLlmFailures: 0,
    autonomousTurnCount: 3,
    openRequest: { requestedAtOffset: 44, expiresAt: 999, model: "openai/gpt-5.6-sol" },
    activeScriptExecutionIds: ["agent-output:7"],
    standingSections: [
      {
        sectionId: "agent/system-prompt",
        occurrences: [
          {
            offset: 2,
            payload: {
              role: "system" as const,
              key: "agent/system-prompt",
              content: "You are a helpful agent.",
              llmRequestPolicy: { behaviour: "after-current-request" as const },
            },
          },
        ],
      },
    ],
    turns: [
      {
        offset: 40,
        payload: {
          role: "user" as const,
          content: "what is the weather?",
          actor: { type: "user" as const, origin: "web" as const },
          llmRequestPolicy: { behaviour: "after-current-request" as const },
        },
      },
    ],
  };
}

test("renders the v5 agent fold as pretty stats, not the raw-JSON fallback", () => {
  const html = renderToStaticMarkup(<AgentPrettyState state={v5AgentState()} />);
  // Pretty view landmarks — absent iff asAgentState fell back to raw JSON.
  expect(html).toContain("phase");
  expect(html).toContain("requested"); // openRequest is set
  expect(html).toContain("#42"); // lastLlmRequestOffset (the "published" stat)
  expect(html).toContain("openai/gpt-5.6-sol"); // config.llm.model
  expect(html).toContain("Open request");
  expect(html).toContain("agent-output:7"); // in-progress script
  expect(html).toContain("what is the weather?"); // last turn preview
  expect(html).toContain("Standing sections"); // the standing lane
});

test("a paused agent shows the paused state", () => {
  const html = renderToStaticMarkup(
    <AgentPrettyState
      state={{
        ...v5AgentState(),
        openRequest: null,
        paused: { reason: "autonomous turn limit reached", atOffset: 50 },
      }}
    />,
  );
  expect(html).toContain("Paused");
  expect(html).toContain("autonomous turn limit reached");
});

test("falls back to raw JSON for a non-agent state (no context lanes)", () => {
  const html = renderToStaticMarkup(<AgentPrettyState state={{ some: "other-processor" }} />);
  expect(html).not.toContain("Open request");
});
