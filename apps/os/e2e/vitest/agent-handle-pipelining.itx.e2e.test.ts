/**
 * Method-returned itx surfaces must support workerd PROMISE PIPELINING from
 * the script lane.
 *
 * Model-authored scripts run in dynamic workers whose `itx` is a workerd RPC
 * stub (`env.ITX` loopback), and models write the natural one-liners:
 *
 *   await itx.agents.get("researcher").message(task);   // child agent, relative path
 *   await itx.agents.get(path).someTool(args);
 *   await itx.capabilityHosts.get(path).runScript(code);
 *
 * Each chains a call onto the un-awaited RESULT of a method — that is workerd
 * promise pipelining. workerd classifies a call result for pipelining with
 * native brand checks (`serializeJsValueWithPipeline` in worker-rpc.c++), and
 * a JS Proxy never passes them (cloudflare/workerd#6873): when these getters'
 * results were instances wrapped in a fallback Proxy, they classified as
 * NonPipelinable and EVERY pipelined call died with the baffling "The RPC
 * receiver does not implement the method ..." — while the awaited two-step
 * worked, and property-path traversal through proxies (which workerd
 * special-cases in `tryGetProperty`) worked too. The fix: instances are
 * genuine, unproxied RpcTargets, and the dynamic-capability fallback lives on
 * each class's PROTOTYPE CHAIN instead (installPrototypeInvokeCapabilityFallback
 * in domains/itx/utils.ts; registry at the bottom of rpc-targets.ts) — so
 * `agents.get(path).someTool(args)` works AND pipelines.
 *
 * This file is the regression guard for that arrangement, exercising the
 * exact expressions the prompts teach, on the exact lane agents use
 * (capability-host runScript → dynamic worker → env.ITX). It FAILS on any
 * build where a method-returned surface is a Proxy.
 */
import { test } from "vitest";
import { createTestProject } from "../test-support/create-test-project.ts";

const PROOF_STREAM = "/e2e/handle-pipelining-proof";
const PROOF_TYPE = "events.iterate.test/handle-pipelining-proof";

test(
  "itx.agents.get(...) pipelines: .message(), .<dynamic capability>(), and .capabilityHost.<dynamic capability>()",
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

        // 2. A dynamic capability DIRECTLY on the fetched handle: proofAppend
        //    is an unknown member, resolved by the prototype-chain fallback
        //    and dispatched through the agent scope's capability host —
        //    all one un-awaited chain.
        const [appended] = await itx.agents.get(${JSON.stringify(agentPath)})
          .proofAppend({
            type: ${JSON.stringify(PROOF_TYPE)},
            payload: { marker: ${JSON.stringify(marker)} },
          });

        // 3. The same capability through the explicit capabilityHost door —
        //    equivalent spelling, also pipelined (capabilityHost is a
        //    property hop, proofAppend the dynamic name).
        const [appendedViaHost] = await itx.agents.get(${JSON.stringify(agentPath)})
          .capabilityHost.proofAppend({
            type: ${JSON.stringify(PROOF_TYPE)},
            payload: { marker: ${JSON.stringify(marker)} + "-via-host" },
          });

        // 4. Another method-returned surface entirely: capabilityHosts.get()
        //    used to hand back a Proxy too — a declared CLASS method must
        //    pipeline (__describe), and so must a DYNAMIC capability name
        //    resolved by the same hop (proofAppend, mounted above).
        const hostDescription = await itx.capabilityHosts.get(${JSON.stringify(agentPath)})
          .__describe();
        const [appendedViaHostsGet] = await itx.capabilityHosts.get(${JSON.stringify(agentPath)})
          .proofAppend({
            type: ${JSON.stringify(PROOF_TYPE)},
            payload: { marker: ${JSON.stringify(marker)} + "-via-hosts-get" },
          });

        return {
          messageOffset: sent.offset,
          messageType: sent.type,
          proofOffset: appended.offset,
          proofType: appended.type,
          proofViaHostOffset: appendedViaHost.offset,
          proofViaHostsGetOffset: appendedViaHostsGet.offset,
          hostPath: hostDescription.path,
        };
      }
    `);

    expect(run.result).toMatchObject({
      messageType: "events.iterate.com/agents/message-received",
      proofType: PROOF_TYPE,
    });
    const result = run.result as {
      messageOffset: number;
      proofOffset: number;
      proofViaHostOffset: number;
      proofViaHostsGetOffset: number;
      hostPath: string;
    };
    expect(result.messageOffset).toBeGreaterThan(0);
    expect(result.proofOffset).toBeGreaterThan(0);
    expect(result.proofViaHostOffset).toBeGreaterThan(result.proofOffset);
    expect(result.proofViaHostsGetOffset).toBeGreaterThan(result.proofViaHostOffset);
    expect(result).toMatchObject({ hostPath: agentPath });

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
  "fan-out: one un-awaited handle serves multiple pipelined calls (capnweb and workerd lanes)",
  { timeout: 120_000 },
  async ({ expect }) => {
    await using handle = await createTestProject({ slugPrefix: "handle-fanout" });
    using itx = handle.itx();

    // THE capnweb-docs pattern, on the capnweb lane (this test body): take a
    // handle WITHOUT awaiting it, then fan out several calls in one
    // Promise.all — dependent calls ride one round trip instead of
    // await-per-hop.
    using capnwebAgent = itx.agents.get("/agents/fanout-capnweb");
    const [sentA, sentB, description] = await Promise.all([
      capnwebAgent.message("capnweb fanout A"),
      capnwebAgent.message("capnweb fanout B"),
      capnwebAgent.__describe(),
    ]);
    expect(sentA).toMatchObject({ type: "events.iterate.com/agents/message-received" });
    expect(sentB).toMatchObject({ type: "events.iterate.com/agents/message-received" });
    expect(sentA).not.toMatchObject({ offset: sentB.offset });
    expect(description).toMatchObject({ agentPath: "/agents/fanout-capnweb" });

    // The same pattern on the WORKERD lane (script isolate over env.ITX),
    // written with a `using` declaration exactly as prompts/examples teach.
    using projectHost = itx.capabilityHosts.get("/");
    const run = await projectHost.runScript(`
      async (itx) => {
        using agent = itx.agents.get("/agents/fanout-workerd");
        const [a, b, desc] = await Promise.all([
          agent.message("workerd fanout A"),
          agent.message("workerd fanout B"),
          agent.__describe(),
        ]);
        return { a: a.offset, b: b.offset, path: desc.agentPath };
      }
    `);
    expect(run.result).toMatchObject({ path: "/agents/fanout-workerd" });
    const result = run.result as { a: number; b: number };
    expect(result).not.toMatchObject({ a: result.b });
    expect(Math.min(result.a, result.b)).toBeGreaterThan(0);
  },
);

test(
  "the child-agent delegation one-liner pipelines from an agent scope (relative path + message)",
  { timeout: 120_000 },
  async ({ expect }) => {
    await using handle = await createTestProject({ slugPrefix: "handle-pipeline-rel" });
    using itx = handle.itx();
    const parentPath = "/agents/pipeline-parent";

    // Run from the PARENT AGENT's scope, so the script's itx resolves relative
    // paths against it and message() stamps the parent as the sender — the
    // verbatim delegation idiom from the subagent system prompt.
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
