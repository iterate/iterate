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

const SubscribeStreamInput = z.object({
  streamPath: z
    .string()
    .trim()
    .min(1)
    .describe("Events stream path to subscribe (e.g. /my/stream)"),
  publicBaseUrl: z
    .string()
    .trim()
    .url()
    .describe(
      "Public origin events.iterate.com should reach this agents deployment at (e.g. your tunnel URL). Usually window.location.origin in the UI.",
    ),
  projectSlug: z
    .string()
    .trim()
    .min(1)
    .default("public")
    .describe("events.iterate.com project slug"),
  agentInstance: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("IterateAgent DO instance name (defaults to a random dev-<slug>)"),
  subscriptionSlug: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Subscription slug on the stream (defaults to a random dev-<slug>)"),
});

const SubscribeStreamResult = z.object({
  streamPath: z.string(),
  callbackUrl: z.string(),
  streamViewerUrl: z.string(),
  appendUrl: z.string(),
  subscriptionSlug: z.string(),
  agentInstance: z.string(),
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
  subscribeStream: oc
    .route({
      operationId: "subscribeStream",
      method: "POST",
      path: "/subscribe-stream",
      description:
        "Subscribe an events.iterate.com stream to this deployment's IterateAgent over WebSocket. The callback URL is derived from the request's public origin.",
      tags: ["/sample"],
    })
    .input(SubscribeStreamInput)
    .output(SubscribeStreamResult),
});
