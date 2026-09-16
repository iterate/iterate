// src/agent/processor.test.ts — the AgentProcessor's executable spec: the reduce as declarative
// `{ events → view }` rows on the shared harness (stream/test-support.ts `reduceProcessor`), and the
// assistant-output parser's rows. The effects — the model call, the script run, the breakers as
// appends — are proven end to end on the worker (e2e/agents.e2e.test.ts, a fake `itx.ai` lent by rule).

import { describe, expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { type AgentView } from "./contract.ts";
import { AgentProcessor, buildChatMessages, renderScriptSettlement } from "./processor.ts";
import { parseCodemodeResponse } from "./codemode-format.ts";

const processor = () =>
  new AgentProcessor({
    chat: () => Promise.reject(new Error("the reduce never calls the model")),
    runScript: () => Promise.reject(new Error("the reduce never runs a script")),
    readFile: () => Promise.reject(new Error("the reduce never reads a file")),
    now: () => 0,
  });

const born = { type: "events.iterate.com/agent/created", payload: { path: "/agents/support" } };
const system = {
  type: "events.iterate.com/agents/context-added",
  payload: { role: "system", content: "Be terse." },
};
const user = (content: string) => ({
  type: "events.iterate.com/agents/context-added",
  payload: { role: "user", content, actor: { type: "user" } },
});
const requested = {
  type: "events.iterate.com/agent/llm-request-requested",
  payload: { model: "m", expiresAt: 999_999 },
};
const settled = (requestOffset: number, result: unknown) => ({
  type: "events.iterate.com/agent/llm-request-settled",
  payload: { requestOffset, result },
});
const assistant = (content: string, llmRequestOffset: number) => ({
  type: "events.iterate.com/agents/context-added",
  payload: { role: "assistant", content, llmRequestOffset },
});
const scriptResult = (executionId: string) => ({
  type: "events.iterate.com/agents/context-added",
  payload: {
    role: "developer",
    content: "Your script returned: 1",
    actor: { type: "script", executionId },
  },
});

describe("AgentProcessor — the reduce", () => {
  const rows: {
    name: string;
    events: { type: string; payload?: unknown }[];
    view: Partial<AgentView>;
  }[] = [
    {
      name: "born with its prompt: the path is set, the system item is in the context, nothing is triggered",
      events: [born, system],
      view: {
        path: "/agents/support",
        contextItems: [{ offset: 2, role: "system", content: "Be terse." }],
        pendingLlmRequestTrigger: null,
      },
    },
    {
      name: "a person's words raise an external trigger; the request records against it and clears it",
      events: [born, system, user("hi"), requested],
      view: {
        pendingLlmRequestTrigger: null,
        openRequest: {
          requestedAtOffset: 4,
          expiresAt: 999_999,
          model: "m",
          triggerSource: "external",
        },
        autonomousTurnCount: 0,
      },
    },
    {
      name: "a late intent — no trigger pending — is a harmless fact; so is one while a request is open",
      events: [born, system, user("hi"), requested, requested],
      view: {
        openRequest: {
          requestedAtOffset: 4,
          expiresAt: 999_999,
          model: "m",
          triggerSource: "external",
        },
      },
    },
    {
      name: "success settles the request and lands the assistant's words, which trigger nothing",
      events: [
        born,
        system,
        user("hi"),
        requested,
        settled(4, { status: "succeeded", text: "ok" }),
        assistant("ok", 4),
      ],
      view: {
        openRequest: null,
        pendingLlmRequestTrigger: null,
        consecutiveLlmFailures: 0,
        contextItems: [
          { offset: 2, role: "system", content: "Be terse." },
          { offset: 3, role: "user", content: "hi", actor: { type: "user" } },
          { offset: 6, role: "assistant", content: "ok", llmRequestOffset: 4 },
        ],
      },
    },
    {
      name: "a failure counts and hands the trigger back with the request's source, for the retry",
      events: [
        born,
        system,
        user("hi"),
        requested,
        settled(4, { status: "failed", errorMessage: "boom" }),
      ],
      view: {
        openRequest: null,
        consecutiveLlmFailures: 1,
        pendingLlmRequestTrigger: { offset: 4, atMs: 5_000, source: "external" },
      },
    },
    {
      name: "expiry drops the turn: no request, no trigger",
      events: [
        born,
        system,
        user("hi"),
        requested,
        settled(4, { status: "cancelled", reason: "expired" }),
      ],
      view: { openRequest: null, pendingLlmRequestTrigger: null, consecutiveLlmFailures: 0 },
    },
    {
      name: "a settlement naming another request is ignored",
      events: [
        born,
        system,
        user("hi"),
        requested,
        settled(99, { status: "succeeded", text: "?" }),
      ],
      view: {
        openRequest: {
          requestedAtOffset: 4,
          expiresAt: 999_999,
          model: "m",
          triggerSource: "external",
        },
      },
    },
    {
      name: "a script is an obligation until settled; its result is agent-loop input that counts an autonomous turn",
      events: [
        born,
        system,
        user("hi"),
        requested,
        {
          type: "events.iterate.com/capability-host/script-run-requested",
          payload: { code: "async (itx) => 1", executionId: "agent-output:6", expiresAt: 7 },
        },
        {
          type: "events.iterate.com/capability-host/script-run-settled",
          payload: {
            executionId: "agent-output:6",
            settlement: { status: "succeeded", result: 1 },
          },
        },
        settled(4, { status: "succeeded", text: "```ts\nasync (itx) => 1\n```" }),
        scriptResult("agent-output:6"),
        requested,
      ],
      view: {
        activeScriptExecutions: {},
        pendingLlmRequestTrigger: null,
        openRequest: {
          requestedAtOffset: 9,
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
        born,
        system,
        user("hi"),
        requested,
        settled(4, { status: "failed", errorMessage: "boom" }),
        { type: "events.iterate.com/agent/paused", payload: { reason: "enough" } },
      ],
      view: { paused: { reason: "enough", atOffset: 6 }, pendingLlmRequestTrigger: null },
    },
    {
      name: "a person's next words reset the autonomous count; paused parks, resumed clears both counts",
      events: [
        born,
        system,
        scriptResult("x"),
        requested,
        settled(4, { status: "failed", errorMessage: "boom" }),
        { type: "events.iterate.com/agent/paused", payload: { reason: "enough" } },
        user("again"),
        { type: "events.iterate.com/agent/resumed", payload: {} },
      ],
      view: {
        paused: null,
        autonomousTurnCount: 0,
        consecutiveLlmFailures: 0,
        pendingLlmRequestTrigger: { offset: 7, atMs: 7_000, source: "external" },
      },
    },
    {
      name: "configured merges: a model change keeps every other knob",
      events: [
        born,
        {
          type: "events.iterate.com/agent/configured",
          payload: { config: { llm: { model: "@cf/x" }, maxAutonomousTurns: 2 } },
        },
      ],
      view: {
        config: {
          llm: { model: "@cf/x" },
          maxAutonomousTurns: 2,
          llmRequestExpiryMs: 600_000,
          llmRequestRetryPolicy: { maxAttempts: 3 },
        },
      },
    },
    {
      name: "words with dont-trigger-request are seen, never answered; a malformed item is skipped",
      events: [
        born,
        {
          type: "events.iterate.com/agents/context-added",
          payload: {
            role: "developer",
            content: "fyi",
            llmRequestPolicy: { behaviour: "dont-trigger-request" },
          },
        },
        {
          type: "events.iterate.com/agents/context-added",
          payload: { role: "nope", content: "x" },
        },
      ],
      view: {
        contextItems: [{ offset: 2, role: "developer", content: "fyi" }],
        pendingLlmRequestTrigger: null,
      },
    },
  ];
  for (const { name, events, view } of rows)
    test(name, () => expect(reduceProcessor(processor(), events)).toMatchObject(view));
});

describe("the conversation as the model reads it (buildChatMessages)", () => {
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
  const items = (files?: (typeof png)[]) => [
    { offset: 1, role: "system" as const, content: "Be terse." },
    { offset: 2, role: "developer" as const, content: "note" },
    { offset: 3, role: "user" as const, content: "Look.", files },
  ];
  test("text items stay text; the developer's notes read as system", () =>
    expect(buildChatMessages(items(), new Map())).toEqual([
      { role: "system", content: "Be terse." },
      { role: "system", content: "note" },
      { role: "user", content: "Look." },
    ]));
  test("an image whose bytes are known becomes an image part beside the text — a data: URL", () =>
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
  test("a non-image attachment, or an image whose bytes are gone, is a hint line the model can act on", () => {
    const [, , message] = buildChatMessages(items([pdf, png]), new Map());
    expect(message!.content).toBe(
      'Look.\n[Attached file: spec.pdf (application/pdf, 9 bytes) — read it with `await itx.files.get("/agents/a/y-spec.pdf").bytes()`]\n[Attached file: dot.png (image/png, 3 bytes) — read it with `await itx.files.get("/agents/a/x-dot.png").bytes()`]',
    );
  });
});

describe("the assistant's output, parsed (the codemode-tag grammar, codemode-format.ts)", () => {
  const rows: { name: string; content: string; expected: object }[] = [
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
  ];
  for (const { name, content, expected } of rows)
    test(name, () => expect(parseCodemodeResponse(content)).toMatchObject(expected));

  test("a settlement renders as the next developer item; a script that returned nothing ends the turn", () => {
    expect(renderScriptSettlement({ status: "succeeded", result: { n: 1 } })).toContain('"n": 1');
    expect(renderScriptSettlement({ status: "succeeded" })).toBeNull();
    expect(
      renderScriptSettlement({ status: "failed", error: "boom", failureKind: "runtime" }),
    ).toContain("boom");
  });
});
