/**
 * Agent handles must support workerd PROMISE PIPELINING from the script lane.
 *
 * Model-authored scripts run in dynamic workers whose `itx` is a workerd RPC
 * stub (`env.ITX` loopback), and models write the natural one-liners:
 *
 *   await itx.agents.get("researcher").message(task);
 *   await itx.agents.get(path).capabilityHost.someTool(args);
 *
 * Both chain a call onto the un-awaited RESULT of `agents.get(...)` — that is
 * workerd promise pipelining. workerd classifies a call result for pipelining
 * with native brand checks (`serializeJsValueWithPipeline` in worker-rpc.c++),
 * and a JS Proxy never passes them: when `get()` returned an AgentRpcTarget
 * wrapped in `withInvokeCapabilityFallback`, the result classified as
 * NonPipelinable and EVERY pipelined call on it died with the baffling
 * "The RPC receiver does not implement the method ..." — while the awaited
 * two-step worked, and property-path traversal through proxies (which workerd
 * special-cases in `tryGetProperty`) worked too. AgentRpcTarget is therefore
 * deliberately a plain, unproxied class (see its comment in rpc-targets.ts),
 * and an agent scope's DYNAMIC capabilities are reached through the
 * `capabilityHost` property — a getter, so its proxied target is traversed,
 * never pipeline-classified.
 *
 * This file is the regression guard for that arrangement, exercising the
 * exact expressions the prompts teach, on the exact lane agents use
 * (capability-host runScript → dynamic worker → env.ITX). It FAILS on any
 * build where `agents.get()` returns a proxied target.
 */
import { test } from "vitest";
import { createTestProject } from "../test-support/create-test-project.ts";

const PROOF_STREAM = "/e2e/handle-pipelining-proof";
const PROOF_TYPE = "events.iterate.test/handle-pipelining-proof";

test(
  "itx.agents.get(...) pipelines: .message() and .capabilityHost.<dynamic capability>()",
  { timeout: 120_000 },
  async ({ expect }) => {
    await using handle = await createTestProject({ slugPrefix: "handle-pipeline" });
    using itx = handle.itx();
    const agentPath = "/agents/pipeline-target";
    const marker = crypto.randomUUID().slice(0, 8);

    // A DURABLE dynamic capability on the agent's scope (an itx-expression
    // method alias: calling it appends to the proof stream). Durable rather
    // than live because the script below runs server-side, long after this
    // capnweb session's live table would have been the wrong place anyway.
    using host = itx.capabilityHosts.get(agentPath);
    using _provision = await host.provideCapability({
      expression: ["streams", ["get", PROOF_STREAM], "append"],
      instructions: "e2e proof: appends its argument to the proof stream.",
      path: ["proofAppend"],
      type: "itx-expression",
    });

    // Run the assertions IN the script lane — a dynamic worker whose itx is a
    // workerd stub. Everything inside is a single un-awaited chain per call:
    // if agents.get() returns anything workerd cannot pipeline on, these
    // throw "The RPC receiver does not implement the method ...".
    using projectHost = itx.capabilityHosts.get("/");
    const run = await projectHost.runScript(`
      async (itx) => {
        // 1. THE one-liner every prompt teaches. message() on the pipelined
        //    result of get(); the first message also births the agent.
        const sent = await itx.agents.get(${JSON.stringify(agentPath)})
          .message("pipelined hello");

        // 2. A dynamic capability through a fetched handle: capabilityHost is
        //    a property (traversal — proxy-safe), proofAppend is the dynamic
        //    name its fallback resolves, still all one un-awaited chain.
        const [appended] = await itx.agents.get(${JSON.stringify(agentPath)})
          .capabilityHost.proofAppend({
            type: ${JSON.stringify(PROOF_TYPE)},
            payload: { marker: ${JSON.stringify(marker)} },
          });

        return {
          messageOffset: sent.offset,
          messageType: sent.type,
          proofOffset: appended.offset,
          proofType: appended.type,
        };
      }
    `);

    expect(run.result).toMatchObject({
      messageType: "events.iterate.com/agents/message-received",
      proofType: PROOF_TYPE,
    });
    const result = run.result as { messageOffset: number; proofOffset: number };
    expect(result.messageOffset).toBeGreaterThan(0);
    expect(result.proofOffset).toBeGreaterThan(0);

    // The side effects are real, not just unthrown: the message folded into
    // the agent stream and the dynamic capability appended the proof event.
    const agentEvents = await itx.streams.get(agentPath).getEvents({});
    expect(
      agentEvents.some(
        (event) =>
          event.type === "events.iterate.com/agents/message-received" &&
          event.payload?.content === "pipelined hello",
      ),
    ).toBe(true);
    const proofEvents = await itx.streams.get(PROOF_STREAM).getEvents({});
    expect(
      proofEvents.some((event) => event.type === PROOF_TYPE && event.payload?.marker === marker),
    ).toBe(true);
  },
);

test(
  "the child-agent one-liner pipelines from an agent scope (relative path + message)",
  { timeout: 120_000 },
  async ({ expect }) => {
    await using handle = await createTestProject({ slugPrefix: "handle-pipeline-rel" });
    using itx = handle.itx();
    const parentPath = "/agents/pipeline-parent";

    // Run from the PARENT AGENT's scope, so the script's itx resolves relative
    // paths against it and message() stamps the parent as the sender — the
    // verbatim delegation idiom from the child-agent system prompt.
    using parentHost = itx.capabilityHosts.get(parentPath);
    const run = await parentHost.runScript(`
      async (itx) => {
        const sent = await itx.agents.get("researcher")
          .message("pipelined delegation");
        return { offset: sent.offset, from: sent.payload.from, path: sent.path };
      }
    `);

    expect(run.result).toMatchObject({
      // Relative resolution against the calling scope…
      path: `${parentPath}/researcher`,
      // …and the sender stamped as the parent agent, because the calling
      // scope is an agent path.
      from: { kind: "agent", path: parentPath },
    });
  },
);
