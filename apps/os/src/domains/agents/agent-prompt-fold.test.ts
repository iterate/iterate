// The section-tree fold (design: tasks/prompt-sections-tree.md, spec-by-demo:
// docs/prompt-sections-demo.html), driven through the public request builder:
// raw committed events in, the exact wire messages out. Everything here is a
// pure re-reduction — the same fold the processor, the request inspector, and
// the mobile Meta tab run.

import { expect, test } from "vitest";
import type { StreamEvent } from "iterate/processors";
import { buildAgentLlmRequestBody } from "./agent-prompt-fold.ts";

test("the standing document is ONE system message — and un-sent keyed re-adds coalesce into it, free", () => {
  const events = [
    // The parsed prompt file: one keyed event per section, committed as one
    // atomic batch — file order becomes offset order becomes document order.
    keyedSystem(1, "identity", "You are the test agent."),
    keyedSystem(2, "output-formatting", "Respond with one fenced ts block."),
    // The birth window: the worker re-adds the same key before any request
    // has been sent — the pending section is edited in place. One section
    // swapped, the other untouched, no fork, no special verb.
    keyedSystem(3, "output-formatting", "Respond with markdown plus one <codemode> tag."),
    userMessage(4, "hello"),
    requested(5),
  ];
  const { messages } = buildAgentLlmRequestBody({ events, llmRequestOffset: 5 });
  expect(messages.map((message) => message.role)).toEqual([
    "system", // protocol
    "system", // the standing document
    "user",
    "developer", // the request's own send stamp
  ]);
  expect(messages[1]!.content).toBe(
    [
      '<section key="identity">',
      "You are the test agent.",
      "</section>",
      "",
      '<section key="output-formatting">',
      "Respond with markdown plus one <codemode> tag.",
      "</section>",
    ].join("\n"),
  );
  expect(messages.at(-1)!.content).toBe(`Requested at: ${isoAt(5)}`);
});

test("a sent section's re-add lands at the tail with supersedes; the standing document stays byte-identical", () => {
  const base = [
    keyedSystem(1, "identity", "You are the test agent."),
    keyedSystem(2, "config/agents-md", "Notes v1."),
    userMessage(3, "hi"),
    requested(4),
  ];
  const before = buildAgentLlmRequestBody({ events: base, llmRequestOffset: 4 });
  const events = [
    ...base,
    settled(5, 4),
    keyedSystem(6, "config/agents-md", "Notes v2."),
    userMessage(7, "and now?"),
    requested(8),
  ];
  const after = buildAgentLlmRequestBody({ events, llmRequestOffset: 8 });

  // The whole earlier request — standing document included — is an exact
  // byte prefix of the new one (the provider cache stays warm), and the
  // update renders at its moment in time with supersedes linkage: everything
  // above it visibly predates it.
  expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
  expect(after.messages.slice(before.messages.length).map((message) => message.content)).toEqual([
    `<section key="config/agents-md" supersedes="@2">\nNotes v2.\n</section>`,
    "and now?",
    `Requested at: ${isoAt(8)}`,
  ]);
});

test("every request's prompt is a strict byte-superset of the previous one — stamps included", () => {
  const events = [
    keyedSystem(1, "identity", "You are the test agent."),
    userMessage(2, "first question"),
    requested(3),
    assistantOutput(4, "first answer", 3),
    settled(5, 3),
    keyedSystem(6, "config/agents-md", "Notes v2."), // temporal update between turns
    userMessage(7, "second question"),
    requested(8),
    assistantOutput(9, "second answer", 8),
    settled(10, 8),
    userMessage(11, "third question"),
    requested(12),
  ];
  const first = buildAgentLlmRequestBody({ events, llmRequestOffset: 3 });
  const second = buildAgentLlmRequestBody({ events, llmRequestOffset: 8 });
  const third = buildAgentLlmRequestBody({ events, llmRequestOffset: 12 });
  expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
  expect(third.messages.slice(0, second.messages.length)).toEqual(second.messages);
  // The newest stamp is the current time; the older stamps are the
  // conversation's own permanent clock lines.
  expect(
    third.messages.filter((message) => message.content.startsWith("Requested at:")),
  ).toHaveLength(3);
});

test("a first-ever key joins the standing document only while no conversation exists; later it lands temporally", () => {
  const events = [
    keyedSystem(1, "identity", "You are the test agent."),
    userMessage(2, "hello"),
    // Conversation exists now — a brand-new key must not rewrite the
    // document above it; it lands at its moment, without supersedes.
    keyedSystem(3, "config/house-style", "House style: all-lowercase."),
    requested(4),
  ];
  const { messages } = buildAgentLlmRequestBody({ events, llmRequestOffset: 4 });
  expect(messages[1]!.content).toBe(
    '<section key="identity">\nYou are the test agent.\n</section>',
  );
  expect(messages.map((message) => message.content.split("\n")[0])).toEqual([
    expect.stringContaining("Journal-projected context messages"),
    '<section key="identity">',
    "hello",
    '<section key="config/house-style">',
    expect.stringContaining("Requested at:"),
  ]);
});

test("context-rewritten replace swaps what past positions contain — the deliberate cache-busting rewrite", () => {
  const events = [
    keyedSystem(1, "config/house-style", "House style: all-lowercase."),
    userMessage(2, "hi"),
    requested(3),
    settled(4, 3),
    // The scenario-3a shape: a bare rewrite of a sent behavioral rule. The
    // fold obeys — the standing document changes in place and any temporal
    // occurrences of the key vanish. (Don't do this for routine changes;
    // re-add the key instead.)
    contextRewritten(5, {
      op: "replace",
      key: "config/house-style",
      content: "House style: proper capitalisation.",
    }),
    requested(6),
  ];
  const before = buildAgentLlmRequestBody({ events, llmRequestOffset: 3 });
  const after = buildAgentLlmRequestBody({ events, llmRequestOffset: 6 });
  expect(before.messages[1]!.content).toContain("all-lowercase");
  expect(after.messages[1]!.content).toBe(
    '<section key="config/house-style">\nHouse style: proper capitalisation.\n</section>',
  );
  expect(after.messages.some((message) => message.content.includes("all-lowercase"))).toBe(false);
});

test("context-rewritten delete removes one section; delete * removes everything — standing document and timeline", () => {
  const base = [
    keyedSystem(1, "identity", "You are the test agent."),
    keyedSystem(2, "gotchas", "Await handles."),
    userMessage(3, "remember all of this"),
    requested(4),
    settled(5, 4),
  ];
  const oneGone = buildAgentLlmRequestBody({
    events: [...base, contextRewritten(6, { op: "delete", key: "gotchas" }), requested(7)],
    llmRequestOffset: 7,
  });
  expect(oneGone.messages[1]!.content).toBe(
    '<section key="identity">\nYou are the test agent.\n</section>',
  );

  // The lobotomy: no guardrails, guidance only — the audit trail is the
  // event itself. Protocol, an emptied standing document, the post-delete
  // message, and its stamp are all that remain.
  const allGone = buildAgentLlmRequestBody({
    events: [
      ...base,
      contextRewritten(6, { op: "delete", key: "*" }),
      userMessage(7, "anyone home?"),
      requested(8),
    ],
    llmRequestOffset: 8,
  });
  expect(allGone.messages.map((message) => message.content.split("\n")[0])).toEqual([
    expect.stringContaining("Journal-projected context messages"),
    "",
    "anyone home?",
    expect.stringContaining("Requested at:"),
  ]);
});

test("the standing document keeps first-appearance order — append order is the layout", () => {
  // Keys are arbitrary; the kernel imposes no ordering of its own. Sections
  // render in the order their keys first appeared on the stream — a parsed
  // prompt file's per-section batch commits in file order, so the authored
  // layout is the document order. Hot content like AGENTS.md lands last in
  // every real flow simply because the worker's reaction arrives after the
  // birth batch — authors control placement through their own append order.
  const events = [
    keyedSystem(1, "identity", "You are the test agent."),
    keyedSystem(2, "output-formatting", "One fenced block."),
    keyedSystem(3, "agent/boot-context", "Context for this agent."),
    keyedSystem(4, "config/agents-md", "Notes."),
    keyedSystem(5, "config/house-style", "All lowercase."),
    // A birth-window coalesce keeps its section's first-appearance position.
    keyedSystem(6, "identity", "You are the RENAMED test agent."),
    requested(7),
  ];
  const { messages } = buildAgentLlmRequestBody({ events, llmRequestOffset: 7 });
  expect(messages[1]!.content.split("\n").filter((line) => line.startsWith("<section"))).toEqual([
    '<section key="identity">',
    '<section key="output-formatting">',
    '<section key="agent/boot-context">',
    '<section key="config/agents-md">',
    '<section key="config/house-style">',
  ]);
  expect(messages[1]!.content).toContain("RENAMED");
});

test("a whole-prompt-keyed section and file sections coexist as plain sections — no key supersedes another", () => {
  // "agent/system-prompt" is an authoring convention, not kernel
  // vocabulary: no key triggers clearing of any other key, ever. An old
  // stream whose prompt is one whole-prompt-keyed section keeps rendering
  // exactly that; the doubling case (an old whole-prompt sync coexisting
  // with the new sectioned prompt) is ACCEPTED behavior, to be closed by a
  // prd repo sweep — this spec documents it, it does not guard a shim.
  const events = [
    keyedSystem(1, "identity", "Platform identity."),
    keyedSystem(2, "output-formatting", "Platform format."),
    keyedSystem(3, "agent/system-prompt", "The project's own whole prompt."),
    userMessage(4, "hello"),
    requested(5),
  ];
  const { messages } = buildAgentLlmRequestBody({ events, llmRequestOffset: 5 });
  expect(messages[1]!.content.split("\n").filter((line) => line.startsWith("<section"))).toEqual([
    '<section key="identity">',
    '<section key="output-formatting">',
    '<section key="agent/system-prompt">',
  ]);
  expect(messages[1]!.content).toContain("Platform identity.");
  expect(messages[1]!.content).toContain("The project's own whole prompt.");
});

test("an un-sent temporal occurrence coalesces in place too, keeping its supersedes anchor", () => {
  const events = [
    keyedSystem(1, "config/agents-md", "Notes v1."),
    userMessage(2, "hi"),
    requested(3),
    settled(4, 3),
    // Two rapid re-adds after the send, no request between them: the first
    // lands temporally; the second edits IT (never sent) instead of
    // stacking a third copy.
    keyedSystem(5, "config/agents-md", "Notes v2."),
    keyedSystem(6, "config/agents-md", "Notes v3."),
    requested(7),
  ];
  const { messages } = buildAgentLlmRequestBody({ events, llmRequestOffset: 7 });
  const updates = messages.filter((message) =>
    message.content.split("\n")[0]!.includes("supersedes="),
  );
  expect(updates.map((message) => message.content)).toEqual([
    `<section key="config/agents-md" supersedes="@1">\nNotes v3.\n</section>`,
  ]);
  expect(messages.some((message) => message.content.includes("Notes v2."))).toBe(false);
});

// -----------------------------------------------------------------------------
// Event literals.
// -----------------------------------------------------------------------------

function isoAt(offset: number): string {
  return new Date(1_700_000_000_000 + offset * 1000).toISOString();
}

function streamEvent(offset: number, type: string, payload: unknown): StreamEvent {
  return {
    type,
    payload: payload as Record<string, unknown>,
    offset,
    createdAt: isoAt(offset),
    path: "/agents/test",
  };
}

function contextAdded(offset: number, payload: Record<string, unknown>): StreamEvent {
  return streamEvent(offset, "events.iterate.com/agents/context-added", payload);
}

function contextRewritten(offset: number, payload: Record<string, unknown>): StreamEvent {
  return streamEvent(offset, "events.iterate.com/agents/context-rewritten", payload);
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

function assistantOutput(offset: number, content: string, llmRequestOffset: number): StreamEvent {
  return contextAdded(offset, { role: "assistant", content, llmRequestOffset });
}

function settled(offset: number, requestOffset: number): StreamEvent {
  return streamEvent(offset, "events.iterate.com/agent/llm-request-settled", {
    requestOffset,
    result: { status: "succeeded", text: "ok" },
  });
}

function requested(offset: number): StreamEvent {
  return streamEvent(offset, "events.iterate.com/agent/llm-request-requested", {
    model: "test-model",
    expiresAt: Date.parse("2030-01-01T00:00:00Z"),
  });
}
