// The two-lane section tree fold (design: tasks/prompt-sections-tree.md),
// driven through the public request builder: raw committed events in, the
// exact wire messages out. Everything here is a pure re-reduction — the same
// fold the processor, the request inspector, and the mobile Meta tab run.

import { expect, test } from "vitest";
import type { StreamEvent } from "iterate/processors";
import { buildAgentLlmRequestBody } from "./agent-prompt-fold.ts";

test("replace #id collapses one section and leaves every other standing message byte-identical, order intact", () => {
  const base = [
    contextAdded(1, {
      role: "system",
      content: "",
      segments: [
        { sectionId: "identity", content: "You are the test agent." },
        { sectionId: "output-formatting", content: "Respond with one fenced ts block." },
        { sectionId: "gotchas", content: "Await handles before calling through them." },
      ],
    }),
    contextUpdated(2, { op: "replace", selector: "#config/agents-md", content: "Project notes." }),
    userMessage(3, "hello"),
    requested(4),
  ];
  const before = buildAgentLlmRequestBody({ events: base, llmRequestOffset: 4 });

  const after = buildAgentLlmRequestBody({
    events: [
      ...base,
      contextUpdated(5, {
        op: "replace",
        selector: "#output-formatting",
        content: "Respond with markdown plus one <codemode> tag.",
      }),
      requested(6),
    ],
    llmRequestOffset: 6,
  });

  // Cache-relevant: every message BEFORE the replaced section — and the ones
  // after it — is byte-identical to the previous request; only the one
  // section's message changed, in place. The hot agents-md section stays
  // last in the standing prefix, after the replaced section.
  const changed = after.messages.filter(
    (message, index) => before.messages[index]?.content !== message.content,
  );
  expect(changed).toEqual([
    expect.objectContaining({
      content: '@5 key="output-formatting"\nRespond with markdown plus one <codemode> tag.',
    }),
    // The trailing clock stamp is per-request by design.
    expect.objectContaining({ content: expect.stringContaining("Current date and time") }),
  ]);
  expect(after.messages.slice(0, -1).map((message) => message.content.split("\n")[0])).toEqual(
    before.messages.slice(0, -1).map((message, index) =>
      // Same shape, same order — only the replaced section's source offset moved.
      index === 2 ? '@5 key="output-formatting"' : message.content.split("\n")[0],
    ),
  );
  expect(sectionIdsOf(after)).toEqual([
    "identity",
    "output-formatting",
    "gotchas",
    "config/agents-md",
  ]);
});

test("append-latest keeps the covered occurrence's bytes in place and appends the new one directly after it", () => {
  const base = [
    contextAdded(1, {
      role: "system",
      content: "",
      segments: [{ sectionId: "identity", content: "You are the test agent." }],
    }),
    contextUpdated(2, { op: "replace", selector: "#config/agents-md", content: "Notes v1." }),
    userMessage(3, "hi"),
    requested(4),
  ];
  const events = [
    ...base,
    contextUpdated(5, {
      op: "replace",
      selector: "#config/agents-md",
      content: "Notes v2.",
      mode: "append-latest",
    }),
    requested(6),
  ];
  const { messages } = buildAgentLlmRequestBody({ events, llmRequestOffset: 6 });
  const agentsMd = messages.filter((message) => message.content.includes('key="config/agents-md"'));
  expect(agentsMd).toEqual([
    // The old occurrence's exact bytes stand (prompt-cache prefix intact)…
    expect.objectContaining({ content: '@2 key="config/agents-md"\nNotes v1.' }),
    // …and the correction rides after it as the section's latest occurrence.
    expect.objectContaining({ content: '@5 key="config/agents-md"\nNotes v2.' }),
  ]);
});

test("delete with selector * deletes everything — standing sections included — leaving only protocol and clock", () => {
  const events = [
    contextAdded(1, {
      role: "system",
      content: "",
      segments: [{ sectionId: "identity", content: "You are the test agent." }],
    }),
    userMessage(2, "remember all of this"),
    requested(3),
    contextUpdated(4, { op: "delete", selector: "*" }),
    userMessage(5, "anyone home?"),
    requested(6),
  ];
  const { messages } = buildAgentLlmRequestBody({ events, llmRequestOffset: 6 });
  // No guardrails, guidance only: the lobotomy is complete — the context
  // protocol prompt, the post-delete message, and the clock are all that
  // remain.
  expect(messages.map((message) => message.content.split("\n")[0])).toEqual([
    expect.stringContaining("Journal-projected context messages"),
    "@5 actor=user:web",
    expect.stringContaining("Current date and time"),
  ]);
});

test("delete #id removes one standing section and nothing else", () => {
  const events = [
    contextAdded(1, {
      role: "system",
      content: "",
      segments: [
        { sectionId: "identity", content: "You are the test agent." },
        { sectionId: "gotchas", content: "Await handles." },
      ],
    }),
    contextUpdated(2, { op: "delete", selector: "#gotchas" }),
    userMessage(3, "hello"),
    requested(4),
  ];
  const replay = buildAgentLlmRequestBody({ events, llmRequestOffset: 4 });
  expect(sectionIdsOf(replay)).toEqual(["identity"]);
  expect(replay.messages.some((message) => message.content.includes("Await handles"))).toBe(false);
  expect(replay.messages.some((message) => message.content.includes("hello"))).toBe(true);
});

test("the canonical standing order does not depend on arrival order", () => {
  // The same standing content arriving in two very different orders — hot
  // section first vs last, prompt segments in the middle vs up front.
  const forwards = [
    contextAdded(1, {
      role: "system",
      content: "",
      segments: [
        { sectionId: "identity", content: "You are the test agent." },
        { sectionId: "output-formatting", content: "One fenced block." },
      ],
    }),
    keyedSystem(2, "agent/boot-context", "Context for this agent."),
    keyedSystem(3, "config/house-style", "All lowercase."),
    contextUpdated(4, { op: "replace", selector: "#config/agents-md", content: "Notes." }),
    requested(5),
  ];
  const backwards = [
    contextUpdated(1, { op: "replace", selector: "#config/agents-md", content: "Notes." }),
    keyedSystem(2, "config/house-style", "All lowercase."),
    keyedSystem(3, "agent/boot-context", "Context for this agent."),
    contextAdded(4, {
      role: "system",
      content: "",
      segments: [
        { sectionId: "identity", content: "You are the test agent." },
        { sectionId: "output-formatting", content: "One fenced block." },
      ],
    }),
    requested(5),
  ];
  const canonical = [
    // Platform prompt sections in file order, boot context behind them,
    // other config sections alphabetically, hot sections last.
    "identity",
    "output-formatting",
    "agent/boot-context",
    "config/house-style",
    "config/agents-md",
  ];
  expect(sectionIdsOf(buildAgentLlmRequestBody({ events: forwards, llmRequestOffset: 5 }))).toEqual(
    canonical,
  );
  expect(
    sectionIdsOf(buildAgentLlmRequestBody({ events: backwards, llmRequestOffset: 5 })),
  ).toEqual(canonical);
});

test("legacy keyed events map into the tree: key is the sectionId, uncovered updates collapse, covered ones append as latest", () => {
  const events = [
    keyedSystem(1, "integration/github/status", "status 1"),
    keyedSystem(2, "integration/github/status", "status 2"), // uncovered → collapse
    userMessage(3, "what's up?"),
    requested(4),
    keyedSystem(5, "integration/github/status", "status 3"), // covered → append-as-latest
    requested(6),
  ];
  const { messages } = buildAgentLlmRequestBody({ events, llmRequestOffset: 6 });
  const statuses = messages.filter((message) =>
    message.content.includes('key="integration/github/status"'),
  );
  expect(statuses.map((message) => message.content)).toEqual([
    '@2 key="integration/github/status"\nstatus 2',
    '@5 key="integration/github/status"\nstatus 3',
  ]);
  expect(messages.some((message) => message.content.includes("status 1"))).toBe(false);
});

test("a legacy whole-prompt supersession at key agent/system-prompt clears the segmented prompt sections", () => {
  // The old default-template worker ships the whole (untagged) prompt file
  // keyed agent/system-prompt AFTER the platform birth appended segments —
  // without the umbrella clearing the file sections, every such agent would
  // carry a double prompt (the p1711 trace).
  const events = [
    contextAdded(1, {
      role: "system",
      content: "",
      segments: [
        { sectionId: "identity", content: "Platform identity." },
        { sectionId: "output-formatting", content: "Platform format." },
      ],
    }),
    keyedSystem(2, "agent/system-prompt", "The project's own whole prompt."),
    userMessage(3, "hello"),
    requested(4),
  ];
  const replay = buildAgentLlmRequestBody({ events, llmRequestOffset: 4 });
  expect(sectionIdsOf(replay)).toEqual(["agent/system-prompt"]);
  expect(replay.messages.some((message) => message.content.includes("Platform identity"))).toBe(
    false,
  );
});

test("one event carrying tagged sections AND untagged umbrella content keeps them all — the umbrella clears only PRIOR prompt sections", () => {
  // The MCP prompt shape: the tagged default file plus an untagged override
  // suffix, parsed into one append. The suffix (umbrella) must not clear the
  // sibling sections its own event establishes — and it renders after them.
  const events = [
    contextAdded(1, {
      role: "system",
      content: "",
      segments: [
        { sectionId: "identity", content: "Platform identity." },
        { sectionId: "output-formatting", content: "Platform format." },
        { sectionId: "agent/system-prompt", content: "You are serving the MCP session." },
      ],
    }),
    userMessage(2, "hello"),
    requested(3),
  ];
  const replay = buildAgentLlmRequestBody({ events, llmRequestOffset: 3 });
  expect(sectionIdsOf(replay)).toEqual(["identity", "output-formatting", "agent/system-prompt"]);
});

test("a replace op on a missing section creates it as a standing system section", () => {
  const events = [
    contextUpdated(1, { op: "replace", selector: "#config/agents-md", content: "Fresh notes." }),
    userMessage(2, "hi"),
    requested(3),
  ];
  const { messages } = buildAgentLlmRequestBody({ events, llmRequestOffset: 3 });
  const agentsMd = messages.find((message) => message.content.includes('key="config/agents-md"'))!;
  expect(agentsMd).toMatchObject({ role: "system" });
  expect(agentsMd.content).toBe('@1 key="config/agents-md"\nFresh notes.');
});

// -----------------------------------------------------------------------------
// Event literals.
// -----------------------------------------------------------------------------

function streamEvent(offset: number, type: string, payload: unknown): StreamEvent {
  return {
    type,
    payload: payload as Record<string, unknown>,
    offset,
    createdAt: new Date(1_700_000_000_000 + offset * 1000).toISOString(),
    path: "/agents/test",
  };
}

function contextAdded(offset: number, payload: Record<string, unknown>): StreamEvent {
  return streamEvent(offset, "events.iterate.com/agents/context-added", payload);
}

function contextUpdated(offset: number, payload: Record<string, unknown>): StreamEvent {
  return streamEvent(offset, "events.iterate.com/agents/context-updated", payload);
}

function keyedSystem(offset: number, key: string, content: string): StreamEvent {
  return contextAdded(offset, {
    role: "system",
    key,
    content,
    llmRequestPolicy: { behaviour: "dont-trigger-request" },
  });
}

function userMessage(offset: number, content: string): StreamEvent {
  return contextAdded(offset, {
    role: "user",
    content,
    actor: { type: "user", origin: "web" },
    llmRequestPolicy: { behaviour: "after-current-request" },
  });
}

function requested(offset: number): StreamEvent {
  return streamEvent(offset, "events.iterate.com/agent/llm-request-requested", {
    model: "test-model",
    expiresAt: Date.parse("2030-01-01T00:00:00Z"),
  });
}

/** The standing prefix's section ids, in rendered order, read off the
 * messages' own `key="…"` protocol lines. */
function sectionIdsOf(body: { messages: { content: string }[] }): string[] {
  return body.messages.flatMap((message) => {
    const match = message.content.split("\n")[0]!.match(/key="([^"]+)"/);
    return match === null ? [] : [match[1]!];
  });
}
