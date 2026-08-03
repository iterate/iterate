import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/processors";

const ComputerConfiguration = z.strictObject({
  defaultBackend: z.literal("worker-shell").default("worker-shell").meta({
    description:
      "The Cloudflare Computer backend used when exec does not select one. The spike enables the Worker shell only; a Linux container is a later backend, not a second identity.",
  }),
  defaultTimeoutMs: z.number().int().positive().max(300_000).default(30_000).meta({
    description: "Default bounded command timeout in milliseconds (maximum five minutes).",
  }),
  workingDirectory: z.string().startsWith("/").default("/workspace").meta({
    description: "Default absolute working directory inside this computer.",
  }),
});

const ExecutionRequest = z.strictObject({
  backend: z.literal("worker-shell"),
  command: z.string().min(1),
  executionId: z.string().uuid(),
  incarnationId: z.string().uuid(),
  timeoutMs: z.number().int().positive().max(300_000),
});

const TerminalExecution = z.strictObject({
  executionId: z.string().uuid(),
});

export const ComputerProcessorContract = defineProcessorContract({
  slug: "computer",
  version: "0.1.0-spike.2",
  description:
    "An agent-owned Cloudflare Computer: birth/configuration plus the durable request and terminal outcome of each serialized command.",
  stateSchema: z.object({
    birthCertificate: z
      .strictObject({
        agentPath: z.string().startsWith("/agents/"),
        config: ComputerConfiguration,
      })
      .nullable()
      .default(null),
    config: ComputerConfiguration.prefault({}),
    activeExecution: ExecutionRequest.nullable().default(null),
    lastExecution: z
      .discriminatedUnion("status", [
        z.strictObject({
          executionId: z.string().uuid(),
          exitCode: z.number().int(),
          status: z.literal("completed"),
          syncStatus: z.enum(["complete", "pending"]),
        }),
        z.strictObject({
          error: z.string(),
          executionId: z.string().uuid(),
          status: z.literal("failed"),
        }),
        z.strictObject({
          executionId: z.string().uuid(),
          reason: z.string(),
          status: z.literal("abandoned"),
        }),
      ])
      .nullable()
      .default(null),
  }),
  events: {
    "events.iterate.com/computer/created": {
      description:
        "The computer birth certificate. The owning agent and initial runtime configuration are immutable facts on the computer's own stream.",
      payloadSchema: z.strictObject({
        agentPath: z.string().startsWith("/agents/"),
        config: ComputerConfiguration,
      }),
    },
    "events.iterate.com/computer/configured": {
      description: "Replaces the small runtime policy used by subsequent commands.",
      payloadSchema: z.strictObject({ config: ComputerConfiguration }),
    },
    "events.iterate.com/computer/execution-requested": {
      description:
        "A serialized command was accepted. It remains active until a matching terminal event lands.",
      payloadSchema: ExecutionRequest,
    },
    "events.iterate.com/computer/execution-completed": {
      description:
        "The command exited and the Cloudflare Computer filesystem synchronization result was observed.",
      payloadSchema: TerminalExecution.extend({
        exitCode: z.number().int(),
        syncStatus: z.enum(["complete", "pending"]),
      }),
    },
    "events.iterate.com/computer/execution-failed": {
      description: "The execution attempt threw before producing a shell result.",
      payloadSchema: TerminalExecution.extend({ error: z.string() }),
    },
    "events.iterate.com/computer/execution-abandoned": {
      description:
        "A new Durable Object incarnation found a request with no terminal event and classified it before accepting another command.",
      payloadSchema: TerminalExecution.extend({ reason: z.string() }),
    },
  },
  consumes: [
    "events.iterate.com/computer/created",
    "events.iterate.com/computer/configured",
    "events.iterate.com/computer/execution-requested",
    "events.iterate.com/computer/execution-completed",
    "events.iterate.com/computer/execution-failed",
    "events.iterate.com/computer/execution-abandoned",
  ],
  emits: [],
});

export type ComputerProcessorContract = typeof ComputerProcessorContract;

/** Replayable lifecycle and latest execution state for one agent-owned Computer. */
export type ComputerProcessorState = ProcessorState<ComputerProcessorContract>;

/** Runtime policy controlling an agent-owned Computer's backend, timeout, and cwd. */
export type ComputerConfig = ComputerProcessorState["config"];
