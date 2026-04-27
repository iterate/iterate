import { oc } from "@orpc/contract";
import { internalContract } from "@iterate-com/shared/apps/internal-router-contract";
import { z } from "zod";

const HelloInput = z.object({
  name: z.string().trim().min(1).default("world"),
});

const HelloResult = z.object({
  message: z.string(),
});

const FetchExampleInput = z.object({});

const FetchExampleResult = z.object({
  ok: z.boolean(),
  status: z.number(),
  url: z.string().url(),
  body: z.string(),
});

/**
 * Minimal `EventInput` shape used in the agents-contract for `default events`
 * configuration. The strict event-input union lives in
 * `@iterate-com/events-contract`; we don't import it here because the contract
 * is a leaf package that the events service itself does not depend on, and
 * because the events HTTP API will reject anything malformed at append time
 * anyway. Treating events as `{ type, payload }` here keeps the contract
 * self-contained while still validating the high-level shape.
 *
 * `payload` is typed as `object` (not `Record<string, unknown>`) on purpose so
 * the shape lines up with the looser `GenericEventPayload` used in
 * `@iterate-com/events-contract`. Using `Record<...>` here would make the DO
 * stub method's return type incompatible with this contract's output schema,
 * because `object` (which the strict event variants infer to) is not assignable
 * to `Record<string, unknown>` in TS.
 */
const ContractEventInput = z.object({
  type: z.string().trim().min(1),
  payload: z
    .custom<object>((value) => typeof value === "object" && value !== null && !Array.isArray(value))
    .default({}),
});

const InstallProcessorInput = z.object({
  publicBaseUrl: z
    .string()
    .trim()
    .url()
    .describe(
      "Public origin events.iterate.com should reach this agents deployment at (e.g. your tunnel URL). Usually window.location.origin in the UI.",
    ),
});

const InstallProcessorResult = z.object({
  streamPath: z
    .string()
    .describe(
      "Prefix stream (from `appConfig.streamPathPrefix`) that the auto-subscriber was attached to.",
    ),
  callbackUrl: z
    .string()
    .describe(
      "WebSocket callback URL stored on the subscription. Carries `publicBaseUrl` so the auto-subscriber can reconstruct child-stream callback URLs without extra config.",
    ),
  subscriptionSlug: z.string(),
  projectSlug: z.string(),
});

const ConfigureBasePathDefaultsInput = z.object({
  basePath: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Stream path prefix these defaults apply to (e.g. `/agents` or `/agents/team-x`). Must be an ancestor of `appConfig.streamPathPrefix` or descend from it for the auto-subscriber to ever see matching streams.",
    ),
  events: z
    .array(ContractEventInput)
    .describe(
      "Ordered list of events that should be appended to every new child stream under `basePath`, after the auto-subscriber wires up the iterate-agent processor.",
    ),
});

const ConfigureBasePathDefaultsResult = z.object({
  basePath: z.string(),
  eventCount: z.number().int().nonnegative(),
});

const ClearBasePathDefaultsInput = z.object({
  basePath: z
    .string()
    .trim()
    .min(1)
    .describe("Stream path prefix whose defaults entry should be removed."),
});

const ClearBasePathDefaultsResult = z.object({
  basePath: z.string(),
  existed: z
    .boolean()
    .describe("`true` if there was an entry to clear, `false` if nothing was stored."),
});

const ListBasePathDefaultsInput = z.object({});

const ListBasePathDefaultsResult = z.object({
  configs: z.array(
    z.object({
      basePath: z.string(),
      events: z.array(ContractEventInput),
    }),
  ),
});

const ListAgentsInput = z.object({
  prefix: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional path prefix to filter the result by (e.g. `/agents/joker`). Empty/undefined returns every agent the auto-subscriber has wired up.",
    ),
});

const ListAgentsResult = z.object({
  agents: z.array(
    z.object({
      streamPath: z.string(),
      streamViewerUrl: z
        .string()
        .describe("Pre-built events.iterate.com viewer URL — the sidebar links straight to this."),
      discoveredAt: z.number().int().nonnegative(),
    }),
  ),
});

const CreateAgentInput = z.object({
  streamPath: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Stream path to start the agent at. Must descend from `appConfig.streamPathPrefix` so the auto-subscriber wires it up. The UI enforces this with a fixed prefix.",
    ),
  initialPrompt: z
    .string()
    .min(1)
    .describe(
      "First user message. Appended as an `agent-input-added` event with role `user`, which kicks off the LLM via the processor's debounce timer.",
    ),
});

const CreateAgentResult = z.object({
  streamPath: z.string(),
  streamViewerUrl: z.string().describe("Stream viewer URL (events.iterate.com /streams/...)."),
});

export const agentsContract = oc.router({
  __internal: internalContract,
  hello: oc
    .route({
      operationId: "hello",
      method: "POST",
      path: "/hello",
      description: "Return a tiny sample response from the agents app.",
      tags: ["/sample"],
    })
    .input(HelloInput)
    .output(HelloResult),
  fetchExample: oc
    .route({
      operationId: "fetchExample",
      method: "POST",
      path: "/fetch-example",
      description: "Fetch example.com through the worker's outbound egress path.",
      tags: ["/sample"],
    })
    .input(FetchExampleInput)
    .output(FetchExampleResult),
  installProcessor: oc
    .route({
      operationId: "installProcessor",
      method: "POST",
      path: "/install-processor",
      description:
        "Attach the `child-stream-auto-subscriber` processor to `appConfig.streamPathPrefix`. Each new child stream under the prefix will automatically get an `iterate-agent` WebSocket subscription installed plus any default events configured via `configureBasePathDefaults`.",
      tags: ["/agents-config"],
    })
    .input(InstallProcessorInput)
    .output(InstallProcessorResult),
  configureBasePathDefaults: oc
    .route({
      operationId: "configureBasePathDefaults",
      method: "POST",
      path: "/configure-base-path-defaults",
      description:
        "Store an ordered list of events to append to every new child stream under `basePath`. The auto-subscriber looks up the longest-matching base path on each `child-stream-created` event and applies the events sequentially after the iterate-agent subscription is wired up. Idempotent: writing the same `basePath` twice overwrites the previous entry.",
      tags: ["/agents-config"],
    })
    .input(ConfigureBasePathDefaultsInput)
    .output(ConfigureBasePathDefaultsResult),
  clearBasePathDefaults: oc
    .route({
      operationId: "clearBasePathDefaults",
      method: "POST",
      path: "/clear-base-path-defaults",
      description:
        "Remove the stored default events for a base path. New streams will still get an iterate-agent subscription via the auto-subscriber, but no default events.",
      tags: ["/agents-config"],
    })
    .input(ClearBasePathDefaultsInput)
    .output(ClearBasePathDefaultsResult),
  listBasePathDefaults: oc
    .route({
      operationId: "listBasePathDefaults",
      method: "POST",
      path: "/list-base-path-defaults",
      description: "List every base path that currently has a default-events entry.",
      tags: ["/agents-config"],
    })
    .input(ListBasePathDefaultsInput)
    .output(ListBasePathDefaultsResult),
  listAgents: oc
    .route({
      operationId: "listAgents",
      method: "POST",
      path: "/list-agents",
      description:
        "List every agent (= child stream) the auto-subscriber has discovered, optionally filtered by a path prefix. Powers the dashboard sidebar.",
      tags: ["/agents-config"],
    })
    .input(ListAgentsInput)
    .output(ListAgentsResult),
  createAgent: oc
    .route({
      operationId: "createAgent",
      method: "POST",
      path: "/create-agent",
      description:
        "Append an `agent-input-added` user message to a brand-new (or existing) stream under the auto-subscriber's prefix. The auto-subscriber wires up the iterate-agent durable object and applies any configured base-path defaults; this procedure is a thin convenience wrapper around `events.append`.",
      tags: ["/agents-config"],
    })
    .input(CreateAgentInput)
    .output(CreateAgentResult),
});
