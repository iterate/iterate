// Exercise streamed model responses through the installed agent runtime and its app-owned byte
// transport. Whole-JSON fixtures cannot cover incremental delivery or Response metadata.
import { RpcTarget } from "capnweb";
import { expect } from "vitest";
import { AI_TRANSPORT_SOURCE } from "@iterate-com/agents/ai-transport-source";
import { installAgents } from "@iterate-com/agents/install";
import {
  collector,
  freshCtx,
  readAll,
  rejection,
  sleep,
  until,
} from "../../os/e2e/support/client.ts";
import { FakeAi, sseResponse, sseStream } from "../../os/e2e/support/fake-ai.ts";
import { startOwnWorker } from "../../os/e2e/support/own-worker.ts";
import { localOnly } from "../../os/e2e/support/project-host.ts";
import { agentsWorkspaceSource } from "./agents-source.ts";
import { assistantWords, configureModel, settledLog } from "./fixtures.ts";

class NeverWritingSink extends RpcTarget {
  start() {}
  write() {
    return new Promise<void>(() => {});
  }
  error() {}
}

localOnly(
  "the installed agent settles delayed model streams through env.ITX",
  async () => {
    const worker = await startOwnWorker();
    try {
      const itx = worker.itx(freshCtx("agent-partner-stream"));
      await installAgents(itx, agentsWorkspaceSource);
      const support = itx.cd("/agents/support");
      const secondPart = Promise.withResolvers<void>();
      const partnerAi = new FakeAi([
        () =>
          sseResponse([
            { type: "response.output_text.delta", delta: "A delayed " },
            secondPart.promise,
            { type: "response.output_text.delta", delta: "streamed answer." },
            {
              type: "response.completed",
              response: { usage: { input_tokens: 3, output_tokens: 4 } },
            },
          ]),
      ]);
      await support.provide("itx.ai", partnerAi);
      const chunks = collector();
      await support.subscribe({
        name: "partner-chunks",
        consumes: ["events.iterate.com/agent/llm-response-frame"],
        target: chunks.fn,
      });
      await itx.agents.create("/agents/support");
      await configureModel(support, "gpt-5.6-terra");

      await itx.agents.get("/agents/support").message("Answer in prose.");
      await until(
        "the first partner SSE delta reaches a chunk window",
        () => chunks.invocations.length > 0,
      );
      const beforeRelease = await readAll(support);
      expect(
        beforeRelease.some(
          (event) => event.type === "events.iterate.com/agent/llm-request-settled",
        ),
      ).toBe(false);
      expect(chunks.invocations[0]!.events[0]!.payload).toMatchObject({
        chunks: [{ type: "response.output_text.delta", delta: "A delayed " }],
        sequence: 0,
      });
      secondPart.resolve();
      const events = await settledLog(support, "the streamed partner-model settlement");

      expect(assistantWords(events)).toEqual(["A delayed streamed answer."]);
      expect(partnerAi.calls).toHaveLength(1); // the project's override, rather than the physical binding
      expect(
        events.find((event) => event.type === "events.iterate.com/agent/llm-request-settled")!
          .payload,
      ).toMatchObject({
        result: {
          status: "succeeded",
          text: "A delayed streamed answer.",
          usage: { inputTokens: 3, outputTokens: 4 },
        },
      });

      const native = itx.cd("/agents/worker-ai");
      const workersAi = new FakeAi([
        () => sseStream([{ response: "A native " }, sleep(25), { response: "streamed answer." }]),
      ]);
      await native.provide("itx.ai", workersAi);
      await itx.agents.create("/agents/worker-ai");
      await configureModel(native);
      await itx.agents.get("/agents/worker-ai").message("Answer in prose.");
      const nativeEvents = await settledLog(native, "the streamed Workers AI settlement");
      expect(assistantWords(nativeEvents)).toEqual(["A native streamed answer."]);
      expect(workersAi.calls).toHaveLength(1); // the same override law holds for the @cf stream shape
      expect(
        nativeEvents.find((event) => event.type === "events.iterate.com/agent/llm-request-settled")!
          .payload,
      ).toMatchObject({ result: { status: "succeeded", text: "A native streamed answer." } });

      const masked = itx.cd("/agents/masked-ai");
      const maskedAi = new FakeAi([new Error("a masked itx.ai must never be asked")]);
      await masked.provide("itx.ai", maskedAi);
      await itx.agents.create("/agents/masked-ai");
      await configureModel(masked, "gpt-5.6-terra");
      await masked.provide("itx.ai", null);
      await itx.agents.get("/agents/masked-ai").message("This must not reach the provider.");
      const maskedEvents = await settledLog(masked, "the masked model failure");
      expect(maskedAi).toMatchObject({ calls: [] });
      expect(
        maskedEvents.find((event) => event.type === "events.iterate.com/agent/llm-request-settled")!
          .payload,
      ).toMatchObject({ result: { status: "failed" } });

      const failed = itx.cd("/agents/failed-partner");
      const failedAi = new FakeAi([() => new Response("provider unavailable", { status: 503 })]);
      await failed.provide("itx.ai", failedAi);
      await itx.agents.create("/agents/failed-partner");
      await configureModel(failed, "gpt-5.6-terra");
      await itx.agents.get("/agents/failed-partner").message("This must report provider failure.");
      const failedEvents = await settledLog(failed, "the partner HTTP failure settlement");
      expect(failedAi.calls).toHaveLength(1);
      expect(
        failedEvents.find((event) => event.type === "events.iterate.com/agent/llm-request-settled")!
          .payload,
      ).toMatchObject({
        result: {
          status: "failed",
          errorMessage: "openai/gpt-5.6-terra 503: provider unavailable",
        },
      });

      // A null provider body must stay null through the byte bridge. A closed-but-present stream
      // would instead reach the empty-SSE path and report "the model answered with no text".
      const nullBody = itx.cd("/agents/null-body-partner");
      const nullBodyAi = new FakeAi([() => new Response(null, { status: 204 })]);
      await nullBody.provide("itx.ai", nullBodyAi);
      await itx.agents.create("/agents/null-body-partner");
      await configureModel(nullBody, "gpt-5.6-terra");
      await itx.agents.get("/agents/null-body-partner").message("This has no provider body.");
      const nullBodyEvents = await settledLog(nullBody, "the null-body partner failure");
      expect(nullBodyAi.calls).toHaveLength(1);
      expect(
        nullBodyEvents.find(
          (event) => event.type === "events.iterate.com/agent/llm-request-settled",
        )!.payload,
      ).toMatchObject({
        result: { status: "failed", errorMessage: "openai/gpt-5.6-terra 204: " },
      });

      const failedSse = itx.cd("/agents/failed-sse-partner");
      const failedSseAi = new FakeAi([
        () =>
          sseResponse([
            { type: "response.failed", response: { error: { message: "provider stopped" } } },
            // A frame arrives after the failure. It must not turn the failed request into a later
            // successful answer.
            sleep(25),
            { type: "response.output_text.delta", delta: "late" },
          ]),
      ]);
      await failedSse.provide("itx.ai", failedSseAi);
      await itx.agents.create("/agents/failed-sse-partner");
      await configureModel(failedSse, "gpt-5.6-terra");
      await itx.agents.get("/agents/failed-sse-partner").message("This must stop promptly.");
      const failedSseEvents = await settledLog(failedSse, "the failed SSE settlement");
      expect(failedSseAi.calls).toHaveLength(1);
      expect(
        failedSseEvents.find(
          (event) => event.type === "events.iterate.com/agent/llm-request-settled",
        )!.payload,
      ).toMatchObject({
        result: { status: "failed", errorMessage: "openai: provider stopped" },
      });
      expect(worker.logs()).not.toMatch(/hung and would never generate a response/i);
    } finally {
      await worker.stop();
    }
  },
  120_000,
);

localOnly(
  "the byte transport bounds a stalled sink write",
  async () => {
    const worker = await startOwnWorker();
    try {
      const itx = worker.itx(freshCtx("agent-transport-write-timeout"));
      const modelPath = "/agents/transport-write-timeout";
      const stalledAi = new FakeAi([
        () =>
          sseResponse([
            { type: "response.output_text.delta", delta: "stalled" },
            new Promise(() => {}),
          ]),
      ]);
      await itx.cd(modelPath).provide("itx.ai", stalledAi);
      const error = await rejection(
        itx.workers
          .get({ source: AI_TRANSPORT_SOURCE })
          .run(
            modelPath,
            "gpt-5.6-terra",
            {},
            { returnRawResponse: true },
            new NeverWritingSink(),
            1_000,
          ),
        "the transport's stalled sink write",
        5_000,
      );
      expect(error.message).toContain("model transport sink timeout");
      expect(worker.logs()).not.toMatch(/hung and would never generate a response/i);
    } finally {
      await worker.stop();
    }
  },
  30_000,
);
