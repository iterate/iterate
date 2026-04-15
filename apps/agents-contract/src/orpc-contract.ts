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
});
