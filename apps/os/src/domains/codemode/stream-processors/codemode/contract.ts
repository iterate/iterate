// Defines the "codemode" processor contract on the class-based stream
// processor model. Event types and payload schemas are wire-identical to the
// legacy contract in packages/shared/src/stream-processors/codemode/contract.ts.
//
// Differences from the legacy contract (per the migration decision log,
// apps/os/tasks/stream-processor-class-migration-log.md):
// - the reducer lives on the CodemodeProcessor class, not the contract (D6);
// - standardProcessorBehavior is gone: contract self-registration now rides
//   the host's `stream/subscriber-connected` presence fact, so the
//   `hasRegisteredCurrentVersion` state flag and the consumed/emitted
//   `core/stream-processor-registered` event are dropped (D11).

import { z } from "zod";
import { Callable } from "@iterate-com/shared/callable/types.ts";
import { defineProcessorContract } from "@iterate-com/streams/shared/stream-processors";

const CodemodeId = z.string().trim().min(1);
const CodemodePath = z.array(z.string().min(1)).min(1);
const CodemodeFunctionPath = z.array(z.string().min(1));
const CodemodeVars = z.record(z.string().min(1), z.string());
const ToolProviderInvocation = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("event"),
  }),
  z.object({
    callable: Callable,
    kind: z.literal("rpc"),
  }),
]);
const ToolProviderRegistration = z.object({
  instructions: z.string().trim().min(1),
  invocation: ToolProviderInvocation,
  path: CodemodePath,
});
const CodemodeError = z.unknown();
const Outcome = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("returned"),
    value: z.unknown(),
  }),
  z.object({
    status: z.literal("threw"),
    error: CodemodeError,
  }),
]);
const InvocationKind = z.enum(["event", "rpc"]);

export type ToolProviderRegistration = z.output<typeof ToolProviderRegistration>;

export const CodemodeProcessorContract = defineProcessorContract({
  slug: "codemode",
  version: "0.4.0",
  description:
    "Runs project-scoped codemode scripts from durable stream events and records minimal script/function-call telemetry.",
  stateSchema: z.object({
    sessionStarted: z.boolean().default(false),
    sessionCapabilityCallable: Callable.optional(),
    vars: CodemodeVars.default({}),
    toolProviders: z.record(z.string(), ToolProviderRegistration).default({}),
    scriptExecutions: z
      .record(
        z.string(),
        z.discriminatedUnion("status", [
          z.object({
            status: z.literal("requested"),
            code: z.string(),
            scriptExecutionId: CodemodeId,
          }),
          z.object({
            status: z.literal("completed"),
            durationMs: z.number().int().nonnegative().optional(),
            outcome: Outcome,
            scriptExecutionId: CodemodeId,
          }),
        ]),
      )
      .default({}),
    functionCalls: z
      .record(
        z.string(),
        z.discriminatedUnion("status", [
          z.object({
            status: z.literal("requested"),
            args: z.array(z.unknown()),
            functionCallId: CodemodeId,
            functionPath: CodemodeFunctionPath,
            invocationKind: InvocationKind,
            path: CodemodePath,
            providerPath: CodemodePath,
            scriptExecutionId: CodemodeId.optional(),
          }),
          z.object({
            status: z.literal("completed"),
            durationMs: z.number().int().nonnegative().optional(),
            functionCallId: CodemodeId,
            functionPath: CodemodeFunctionPath,
            invocationKind: InvocationKind,
            outcome: Outcome,
            path: CodemodePath,
            providerPath: CodemodePath,
            scriptExecutionId: CodemodeId.optional(),
          }),
        ]),
      )
      .default({}),
  }),
  initialState: {},
  events: {
    "events.iterate.com/codemode/session-started": {
      description:
        "The codemode processor initialized this stream and published the session capability callable.",
      payloadSchema: z.object({
        sessionCapabilityCallable: Callable,
      }),
    },
    "events.iterate.com/codemode/tool-provider-registered": {
      description: "Model-visible instructions and invocation mode for codemode tool functions.",
      payloadSchema: ToolProviderRegistration,
    },
    "events.iterate.com/codemode/vars-updated": {
      description:
        "String template variables that are exposed to codemode scripts on ctx.codemode.vars.",
      payloadSchema: z.object({
        vars: CodemodeVars,
      }),
    },
    "events.iterate.com/codemode/script-execution-requested": {
      description: "A codemode script should run against the stream's documented functions.",
      examples: [
        {
          description: "Send a chat message",
          payload: {
            code: [
              "async (ctx) => {",
              '  await ctx.chat.sendMessage({ message: "Hello!" })',
              "}",
            ].join("\n"),
            scriptExecutionId: "example-chat",
          },
        },
        {
          description: "Fetch data and send the result",
          payload: {
            code: [
              "async (ctx) => {",
              '  const res = await fetch("https://api.example.com/data")',
              "  const data = await res.json()",
              "  await ctx.chat.sendMessage({ message: JSON.stringify(data, null, 2) })",
              "}",
            ].join("\n"),
            scriptExecutionId: "example-fetch",
          },
        },
        {
          description:
            "When a Slack reply is needed, acknowledge immediately then do work in parallel",
          payload: {
            code: [
              "async (ctx) => {",
              "  const thread = await ctx.slack.agent.threadInfo()",
              "  const [, data] = await Promise.all([",
              '    ctx.slack.chat.postMessage({ channel: thread.channel, thread_ts: thread.thread_ts, text: "Looking into it..." }),',
              '    fetch("https://api.example.com/data").then(r => r.json()),',
              "  ])",
              "  await ctx.slack.chat.postMessage({",
              "    channel: thread.channel,",
              "    thread_ts: thread.thread_ts,",
              "    text: `Found: ${JSON.stringify(data)}`,",
              "  })",
              "}",
            ].join("\n"),
            scriptExecutionId: "example-slack-parallel",
          },
        },
        {
          description: "Read the current stream history",
          payload: {
            code: [
              "async (ctx) => {",
              "  const events = await ctx.streams.read()",
              "  const summary = events.map(e => `${e.offset}: ${e.type}`).join('\\n')",
              "  await ctx.chat.sendMessage({ message: summary })",
              "}",
            ].join("\n"),
            scriptExecutionId: "example-read-stream",
          },
        },
      ],
      payloadSchema: z.object({
        code: z.string().min(1),
        scriptExecutionId: CodemodeId,
      }),
    },
    "events.iterate.com/codemode/script-execution-completed": {
      description: "A codemode script completed with either an output or a serialized error.",
      payloadSchema: z.object({
        durationMs: z.number().int().nonnegative().optional(),
        outcome: Outcome,
        scriptExecutionId: CodemodeId,
      }),
    },
    "events.iterate.com/codemode/function-call-requested": {
      description:
        "A codemode script or function implementation requested a documented function path.",
      payloadSchema: z.object({
        args: z.array(z.unknown()),
        functionCallId: CodemodeId,
        functionPath: CodemodeFunctionPath,
        invocationKind: InvocationKind,
        path: CodemodePath,
        providerPath: CodemodePath,
        scriptExecutionId: CodemodeId.optional(),
      }),
    },
    "events.iterate.com/codemode/function-call-completed": {
      description:
        "A requested function call completed with either an output or a serialized error.",
      payloadSchema: z.object({
        durationMs: z.number().int().nonnegative().optional(),
        functionCallId: CodemodeId,
        functionPath: CodemodeFunctionPath,
        invocationKind: InvocationKind,
        outcome: Outcome,
        path: CodemodePath,
        providerPath: CodemodePath,
        scriptExecutionId: CodemodeId.optional(),
      }),
    },
    "events.iterate.com/codemode/log-emitted": {
      description: "A codemode script emitted a log line.",
      payloadSchema: z.object({
        level: z.enum(["log", "warn", "error"]),
        message: z.string(),
        scriptExecutionId: CodemodeId.optional(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/codemode/session-started",
    "events.iterate.com/codemode/tool-provider-registered",
    "events.iterate.com/codemode/vars-updated",
    "events.iterate.com/codemode/script-execution-requested",
    "events.iterate.com/codemode/script-execution-completed",
    "events.iterate.com/codemode/function-call-requested",
    "events.iterate.com/codemode/function-call-completed",
    "events.iterate.com/codemode/log-emitted",
  ],
  emits: [
    "events.iterate.com/codemode/session-started",
    "events.iterate.com/codemode/script-execution-requested",
    "events.iterate.com/codemode/script-execution-completed",
    "events.iterate.com/codemode/function-call-requested",
    "events.iterate.com/codemode/function-call-completed",
    "events.iterate.com/codemode/log-emitted",
  ],
});

export function toolProviderRegistryKey(path: readonly string[]) {
  return JSON.stringify(path);
}

export type CodemodeState = z.infer<typeof CodemodeProcessorContract.stateSchema>;
