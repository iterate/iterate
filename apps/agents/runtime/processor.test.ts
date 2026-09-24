// runtime/processor.test.ts — the AgentProcessor's executable spec: the reduce as declarative
// `{ events → state }` rows on the shared harness (apps/os/src/stream/test-support.ts
// `reduceProcessor`), and the assistant-output parser's rows. The effects — the birth saga, the
// model call, the script run, the breakers as appends — are proven end to end on the worker
// (e2e/agents.e2e.test.ts, a fake `itx.ai` lent by rule).

import { expect, test } from "vitest";
import { reduceProcessor } from "../../os/src/stream/test-support.ts";
import { type AgentState } from "./contract.ts";
import {
  AgentProcessor,
  buildChatMessages,
  renderCapabilityTree,
  renderScriptSettlement,
} from "./processor.ts";
import { parseCodemodeResponse } from "./codemode-format.ts";

const requested = { type: "events.iterate.com/agent/create-requested", payload: {} };
const created = { type: "events.iterate.com/agent/created", payload: { path: "/agents/support" } };
const failed = { type: "events.iterate.com/agent/create-failed", payload: { error: "boom" } };
const deleteRequested = { type: "events.iterate.com/agent/delete-requested", payload: {} };
const deleted = { type: "events.iterate.com/agent/deleted", payload: { path: "/agents/support" } };
/** Born: the request, then the certificate (offsets 1 and 2 of every row below). */
const born = [requested, created];
const system = {
  type: "events.iterate.com/agent/context-added",
  payload: { role: "system", content: "Be terse." },
};

test.for<{
  name: string;
  events: { type: string; payload?: unknown }[];
  state: Partial<AgentState>;
}>([
  {
    name: "the empty state",
    events: [],
    state: { creation: null, deletion: null, contextItems: [] },
  },
  {
    name: "a request opens the creation, at its offset",
    events: [requested],
    state: { creation: { status: "requested", offset: 1 } },
  },
  {
    name: "a failure closes the attempt at its offset (the error is on that event, not in state)",
    events: [requested, failed],
    state: { creation: { status: "failed", offset: 2 } },
  },
  {
    name: "a request after a failure is a new attempt",
    events: [requested, failed, requested],
    state: { creation: { status: "requested", offset: 3 } },
  },
  {
    name: "born once: a request after the certificate is a harmless fact",
    events: [...born, requested],
    state: { creation: { status: "created", offset: 2 } },
  },
  {
    name: "a failure after the certificate is a harmless fact too: the entity stays created",
    events: [requested, created, failed],
    state: { creation: { status: "created", offset: 2 } },
  },
  {
    name: "the empty state has moved never",
    events: [],
    state: { lastActivityAt: null },
  },
  {
    name: "every change stamps the event's time; a harmless fact after it stamps nothing",
    events: [...born, requested],
    state: { lastActivityAt: new Date(2000).toISOString() },
  },
  {
    name: "a delete request opens the deletion at its offset; creation is untouched",
    events: [...born, deleteRequested],
    state: {
      creation: { status: "created", offset: 2 },
      deletion: { status: "requested", offset: 3 },
    },
  },
  {
    name: "the death certificate completes it, at its offset; creation is still untouched",
    events: [...born, deleteRequested, deleted],
    state: {
      creation: { status: "created", offset: 2 },
      deletion: { status: "deleted", offset: 4 },
    },
  },
  {
    name: "dies once, not re-creatable: a second delete request and a create request after the certificate are harmless facts",
    events: [...born, deleteRequested, deleted, deleteRequested, requested],
    state: {
      creation: { status: "created", offset: 2 },
      deletion: { status: "deleted", offset: 4 },
    },
  },
  {
    name: "born with its prompt: the creation is complete, the system item is in the context, nothing is triggered",
    events: [...born, system],
    state: {
      creation: { status: "created", offset: 2 },
      contextItems: [{ offset: 3, role: "system", content: "Be terse." }],
      pendingLlmRequestTrigger: null,
    },
  },
  {
    name: "a person's words raise an external trigger; the request records against it and clears it",
    events: [...born, system, user("hi"), llmRequested(4)],
    state: {
      pendingLlmRequestTrigger: null,
      openRequest: {
        requestedAtOffset: 5,
        expiresAt: 999_999,
        model: "m",
        triggerSource: "external",
      },
      autonomousTurnCount: 0,
    },
  },
  {
    name: "a late intent — no trigger pending — is a harmless fact; so is one while a request is open",
    events: [...born, system, user("hi"), llmRequested(4), llmRequested(4)],
    state: {
      openRequest: {
        requestedAtOffset: 5,
        expiresAt: 999_999,
        model: "m",
        triggerSource: "external",
      },
    },
  },
  {
    name: "success settles the request and lands the assistant's words, which trigger nothing",
    events: [
      ...born,
      system,
      user("hi"),
      llmRequested(4),
      settled(5, { status: "succeeded", text: "ok" }),
      assistant("ok", 5),
    ],
    state: {
      openRequest: null,
      pendingLlmRequestTrigger: null,
      consecutiveLlmFailures: 0,
      contextItems: [
        { offset: 3, role: "system", content: "Be terse." },
        { offset: 4, role: "user", content: "hi", actor: { type: "user" } },
        { offset: 7, role: "assistant", content: "ok", llmRequestOffset: 5 },
      ],
    },
  },
  {
    name: "a failure counts and hands the trigger back with the request's source, for the retry",
    events: [
      ...born,
      system,
      user("hi"),
      llmRequested(4),
      settled(5, { status: "failed", errorMessage: "boom" }),
    ],
    state: {
      openRequest: null,
      consecutiveLlmFailures: 1,
      pendingLlmRequestTrigger: { offset: 5, atMs: 6_000, source: "external" },
    },
  },
  {
    name: "expiry drops the turn: no request, no trigger",
    events: [
      ...born,
      system,
      user("hi"),
      llmRequested(4),
      settled(5, { status: "cancelled", reason: "expired" }),
    ],
    state: { openRequest: null, pendingLlmRequestTrigger: null, consecutiveLlmFailures: 0 },
  },
  {
    name: "a settlement naming another request is ignored",
    events: [
      ...born,
      system,
      user("hi"),
      llmRequested(4),
      settled(99, { status: "succeeded", text: "?" }),
    ],
    state: {
      openRequest: {
        requestedAtOffset: 5,
        expiresAt: 999_999,
        model: "m",
        triggerSource: "external",
      },
    },
  },
  {
    name: "a script's result is agent-loop input: the next request records an agent-loop trigger and counts an autonomous turn",
    events: [
      ...born,
      system,
      user("hi"),
      llmRequested(4),
      {
        type: "events.iterate.com/context/run-requested",
        payload: { code: "async (itx) => 1" },
      },
      {
        type: "events.iterate.com/context/run-settled",
        payload: {
          requestOffset: 6,
          settlement: { status: "succeeded", result: 1 },
        },
      },
      settled(5, { status: "succeeded", text: "<codemode>\nreturn 1\n</codemode>" }),
      scriptResult(6),
      llmRequested(9),
    ],
    state: {
      pendingLlmRequestTrigger: null,
      openRequest: {
        requestedAtOffset: 10,
        expiresAt: 999_999,
        model: "m",
        triggerSource: "agent-loop",
      },
      autonomousTurnCount: 1,
    },
  },
  {
    name: "a pause drops the parked trigger — the retry that tripped the breaker cannot resume it",
    events: [
      ...born,
      system,
      user("hi"),
      llmRequested(4),
      settled(5, { status: "failed", errorMessage: "boom" }),
      { type: "events.iterate.com/agent/paused", payload: { reason: "enough" } },
    ],
    state: { paused: { reason: "enough", atOffset: 7 }, pendingLlmRequestTrigger: null },
  },
  {
    name: "a person's next words reset the autonomous count; paused parks, resumed clears both counts",
    events: [
      ...born,
      system,
      scriptResult(1), // a script result as the trigger: agent-loop input
      llmRequested(4),
      settled(5, { status: "failed", errorMessage: "boom" }),
      { type: "events.iterate.com/agent/paused", payload: { reason: "enough" } },
      user("again"),
      { type: "events.iterate.com/agent/resumed", payload: {} },
    ],
    state: {
      paused: null,
      autonomousTurnCount: 0,
      consecutiveLlmFailures: 0,
      pendingLlmRequestTrigger: { offset: 8, atMs: 8_000, source: "external" },
    },
  },
  {
    name: "configured merges: a model change keeps every other knob",
    events: [
      ...born,
      {
        type: "events.iterate.com/agent/configured",
        payload: { config: { llm: { model: "@cf/x" }, maxAutonomousTurns: 2 } },
      },
    ],
    state: {
      config: {
        llm: { model: "@cf/x" },
        maxAutonomousTurns: 2,
        llmRequestExpiryMs: 600_000,
        llmRequestDebounceMs: 250,
        llmRequestRetryPolicy: { maxAttempts: 3, backoffBaseMs: 10_000, backoffMaxMs: 60_000 },
      },
    },
  },
  {
    name: "words with dont-trigger-request are seen, never answered; a malformed item is skipped",
    events: [
      ...born,
      {
        type: "events.iterate.com/agent/context-added",
        payload: {
          role: "developer",
          content: "fyi",
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        },
      },
      {
        type: "events.iterate.com/agent/context-added",
        payload: { role: "nope", content: "x" },
      },
    ],
    state: {
      contextItems: [{ offset: 3, role: "developer", content: "fyi" }],
      pendingLlmRequestTrigger: null,
    },
  },
])("the reduce: $name", ({ events, state }) => {
  expect(reduceProcessor(processor(), events)).toMatchObject(state);
});

// ── the conversation as the model reads it (buildChatMessages) ──

const png = {
  contentType: "image/png",
  filename: "dot.png",
  path: "/agents/a/x-dot.png",
  size: 3,
};
const pdf = {
  contentType: "application/pdf",
  filename: "spec.pdf",
  path: "/agents/a/y-spec.pdf",
  size: 9,
};

test("buildChatMessages: text items stay text; the developer's notes read as system", () =>
  expect(buildChatMessages(items(), new Map())).toEqual([
    { role: "system", content: "Be terse." },
    { role: "system", content: "note" },
    { role: "user", content: "Look." },
  ]));
test("buildChatMessages: an image whose bytes are known becomes an image part beside the text — a data: URL", () =>
  expect(
    buildChatMessages(
      items([png]),
      new Map([[png.path, { contentType: "image/png", base64: "QUJD" }]]),
    )[2],
  ).toEqual({
    role: "user",
    content: [
      { type: "text", text: "Look." },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ],
  }));
test("buildChatMessages: a non-image attachment, or an image whose bytes are gone, is a hint line the model can act on", () => {
  const [, , message] = buildChatMessages(items([pdf, png]), new Map());
  expect(message).toMatchObject({
    content:
      'Look.\n[Attached file: spec.pdf (application/pdf, 9 bytes) — read it with `await itx.files.get("/agents/a/y-spec.pdf").bytes()`]\n[Attached file: dot.png (image/png, 3 bytes) — read it with `await itx.files.get("/agents/a/x-dot.png").bytes()`]',
  });
});

// ── the assistant's output, parsed (the codemode-tag grammar, codemode-format.ts) ──

test.for<{ name: string; content: string; expected: object }>([
  {
    name: "prose, one tag with a status, trailing prose: bare statements get the async envelope, the prose halves join",
    content:
      'Let me look.\n\n<codemode status="Checking">\nconst n = 1\nreturn { n }\n</codemode>\n\nDone soon.',
    expected: {
      kind: "script",
      code: "async (itx) => {\nconst n = 1\nreturn { n }\n}",
      status: "Checking",
      prose: "Let me look.\n\nDone soon.",
    },
  },
  {
    name: "a body that is already an async function passes through untouched; no status, no prose",
    content: "<codemode>\nasync (itx) => 1\n</codemode>",
    expected: { kind: "script", code: "async (itx) => 1" },
  },
  {
    name: "no tag is a turn's end, the prose still delivered; nothing at all is none",
    content: "All done — the value is 42.",
    expected: { kind: "none", prose: "All done — the value is 42." },
  },
  { name: "an empty answer is none without prose", content: "  \n", expected: { kind: "none" } },
  {
    name: "a mid-line mention never opens a tag",
    content: "To run code, use a <codemode> tag on its own line.",
    expected: { kind: "none", prose: "To run code, use a <codemode> tag on its own line." },
  },
  {
    name: "two openers run nothing",
    content: "<codemode>\nreturn 1\n</codemode>\n<codemode>\nreturn 2\n</codemode>",
    expected: { kind: "multiple" },
  },
  {
    name: "an unclosed tag is malformed",
    content: "<codemode>\nreturn 1",
    expected: { kind: "malformed" },
  },
  {
    name: "a stray closer before the opener is malformed",
    content: "</codemode>\n<codemode>\nreturn 1\n</codemode>",
    expected: { kind: "malformed" },
  },
  {
    name: "an empty body is malformed",
    content: "<codemode>\n\n</codemode>",
    expected: { kind: "malformed" },
  },
  {
    name: "the body ends at the LAST closer: a closing line inside a template literal stays in the script",
    content: "<codemode>\nconst s = `\n</codemode>\n`\nreturn s\n</codemode>",
    expected: {
      kind: "script",
      code: "async (itx) => {\nconst s = `\n</codemode>\n`\nreturn s\n}",
    },
  },
])("parseCodemodeResponse: $name", ({ content, expected }) => {
  expect(parseCodemodeResponse(content)).toMatchObject(expected);
});

test("renderScriptSettlement: a settlement renders as the next developer item; a script that returned nothing ends the turn", () => {
  expect(renderScriptSettlement({ status: "succeeded", result: { n: 1 } })).toContain('"n": 1');
  expect(renderScriptSettlement({ status: "succeeded" })).toBeNull();
  expect(
    renderScriptSettlement({ status: "failed", error: "boom", failureKind: "runtime" }),
  ).toContain("boom");
});

// ── the capability tree the model reads ──

test("renderCapabilityTree: one line per row, masks and the sandbox's own link omitted, grouped by the context each row came from", () => {
  expect(renderCapabilityTree([])).toBeNull();
  expect(
    renderCapabilityTree([
      { match: "itx", target: "itx.builtins.cd('/agents/a')", context: "/agents/a/sandbox" },
      { match: "itx.kv", target: null, context: "/agents/a/sandbox" },
      {
        match: "itx.catalogue",
        target: "itx.builtins.cd('/').catalogue",
        description: "search the catalogue: itx.catalogue({ q })",
        context: "/agents/a/sandbox",
      },
    ]),
  ).toBe(
    [
      "`itx` IS THIS CONTEXT'S CAPABILITY TREE (`await itx.rewriteRules.list()`) — every name below is one you can spell inside a tag; nothing else resolves:",
      "from /agents/a/sandbox:",
      "itx.catalogue — search the catalogue: itx.catalogue({ q })",
    ].join("\n"),
  );
  expect(
    renderCapabilityTree([
      {
        match: "itx.append",
        target: "itx.builtins.append",
        description: "write here",
        context: "/a",
      },
      { match: "itx.tool", target: "itx.builtins.rpcStubs.get('itx.tool')", context: "/" },
    ]),
  ).toContain(
    "from /a:\nitx.append — write here\nfrom /:\nitx.tool — ⇒ itx.builtins.rpcStubs.get('itx.tool')",
  );
});

test("buildChatMessages: the tree rides as ONE system message after the journaled system prompt, fresh each turn; none when the tree is empty", () => {
  const items = [
    { offset: 1, role: "system", content: "rules", files: [] },
    { offset: 2, role: "user", content: "hi", files: [] },
  ] as unknown as AgentState["contextItems"];
  expect(buildChatMessages(items, new Map())).toHaveLength(2);
  const withTree = buildChatMessages(items, new Map(), [
    { match: "itx.kv", target: "itx.builtins.kv", description: "kv", context: "/" },
  ]);
  expect(withTree.map((m) => m.role)).toEqual(["system", "system", "user"]);
  expect(withTree[1]!.content).toContain("itx.kv — kv");
});

/** The reduce never reaches the context; the saga and the model call are the e2e's. */
const processor = () =>
  new AgentProcessor({
    withItx: () => Promise.reject(new Error("the reduce reaches no itx")),
    runModel: () => Promise.reject(new Error("the reduce reaches no model transport")),
    now: () => 0,
    sleep: () => Promise.resolve(),
  });

// Row builders are function declarations: the rows call them while the file is collected.
function user(content: string) {
  return {
    type: "events.iterate.com/agent/context-added",
    payload: { role: "user", content, actor: { type: "user" } },
  };
}

function llmRequested(triggerOffset: number) {
  return {
    type: "events.iterate.com/agent/llm-request-requested",
    payload: { model: "m", expiresAt: 999_999, triggerOffset },
  };
}

function settled(requestOffset: number, result: unknown) {
  return {
    type: "events.iterate.com/agent/llm-request-settled",
    payload: { requestOffset, result },
  };
}

function assistant(content: string, llmRequestOffset: number) {
  return {
    type: "events.iterate.com/agent/context-added",
    payload: { role: "assistant", content, llmRequestOffset },
  };
}

function scriptResult(requestOffset: number) {
  return {
    type: "events.iterate.com/agent/context-added",
    payload: {
      role: "developer",
      content: "Your script returned: 1",
      actor: { type: "script", requestOffset },
    },
  };
}

const items = (files?: (typeof png)[]) => [
  { offset: 1, role: "system" as const, content: "Be terse." },
  { offset: 2, role: "developer" as const, content: "note" },
  { offset: 3, role: "user" as const, content: "Look.", files },
];
