// Exercise streamed model responses through the installed agent runtime and its app-owned byte
// transport. Whole-JSON fixtures cannot cover incremental delivery or Response metadata.
import { RpcTarget } from "capnweb";
import { expect } from "vitest";
import { collector, freshCtx, readAll, rejection, until } from "../../os/e2e/support/client.ts";
import { startLoggedWorker } from "../../os/e2e/support/log-harness.ts";
import { localOnly } from "../../os/e2e/support/project-host.ts";
import { buildAgentRuntime } from "../scripts/build-runtime.ts";
import { AI_TRANSPORT_SOURCE } from "../runtime/ai-transport-source.ts";
import { installAgents } from "../runtime/install.ts";
import { assistantWords, onWorkersAi } from "./fixtures.ts";

class DeferredResponsesAi extends RpcTarget {
  calls = 0;
  #releaseSecond!: () => void;
  readonly secondPart = new Promise<void>((resolve) => (this.#releaseSecond = resolve));

  release() {
    this.#releaseSecond();
  }

  run() {
    this.calls += 1;
    const encoder = new TextEncoder();
    const secondPart = this.secondPart;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          encoder.encode('data: {"type":"response.output_text.delta","delta":"A delayed "}\n\n'),
        );
        await secondPart;
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.output_text.delta","delta":"streamed answer."}\n\n' +
              'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":4}}}\n\n',
          ),
        );
        controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }
}

class FailedResponsesAi extends RpcTarget {
  calls = 0;
  run() {
    this.calls += 1;
    return new Response("provider unavailable", { status: 503 });
  }
}

class NullBodyResponsesAi extends RpcTarget {
  calls = 0;
  run() {
    this.calls += 1;
    return new Response(null, { status: 204 });
  }
}

class FailedSseThenMoreResponsesAi extends RpcTarget {
  calls = 0;

  run() {
    this.calls += 1;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.failed","response":{"error":{"message":"provider stopped"}}}\n\n',
          ),
        );
        // A second byte arrives after the failure. It must not turn the failed request into a
        // later successful answer.
        setTimeout(() => {
          controller.enqueue(
            encoder.encode('data: {"type":"response.output_text.delta","delta":"late"}\n\n'),
          );
          controller.close();
        }, 25);
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }
}

class OneChunkThenStallAi extends RpcTarget {
  run() {
    const bytes = new TextEncoder().encode(
      'data: {"type":"response.output_text.delta","delta":"stalled"}\n\n',
    );
    return new Response(
      new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(bytes) }),
    );
  }
}

class NeverWritingSink extends RpcTarget {
  start() {}
  write() {
    return new Promise<void>(() => {});
  }
  error() {}
}

class DelayedWorkersAi extends RpcTarget {
  calls = 0;
  run() {
    this.calls += 1;
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"response":"A native "}\n\n'));
        setTimeout(() => {
          controller.enqueue(encoder.encode('data: {"response":"streamed answer."}\n\n'));
          controller.close();
        }, 25);
      },
    });
  }
}

localOnly(
  "the installed agent settles delayed model streams through env.ITX.get",
  async () => {
    const worker = await startLoggedWorker();
    try {
      const itx = worker.itx(freshCtx("agent-partner-stream"));
      await installAgents(itx, await buildAgentRuntime());
      const support = itx.cd("/agents/support");
      const partnerAi = new DeferredResponsesAi();
      await support.provide("itx.ai", partnerAi);
      const chunks = collector();
      await support.subscribe({
        name: "partner-chunks",
        consumes: ["events.iterate.com/agent/llm-response-chunks"],
        target: chunks.fn,
      });
      await itx.agents.create("/agents/support");
      await onWorkersAi(support, "gpt-5.6-terra");

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
      partnerAi.release();
      const events = await until("the streamed partner-model settlement", async () => {
        const all = await readAll(support);
        return all.some((event) => event.type === "events.iterate.com/agent/llm-request-settled")
          ? all
          : undefined;
      });

      expect(assistantWords(events)).toEqual(["A delayed streamed answer."]);
      expect(partnerAi.calls).toBe(1); // the project's override, rather than the physical binding
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
      const workersAi = new DelayedWorkersAi();
      await native.provide("itx.ai", workersAi);
      await itx.agents.create("/agents/worker-ai");
      await onWorkersAi(native);
      await itx.agents.get("/agents/worker-ai").message("Answer in prose.");
      const nativeEvents = await until("the streamed Workers AI settlement", async () => {
        const all = await readAll(native);
        return all.some((event) => event.type === "events.iterate.com/agent/llm-request-settled")
          ? all
          : undefined;
      });
      expect(assistantWords(nativeEvents)).toEqual(["A native streamed answer."]);
      expect(workersAi.calls).toBe(1); // the same override law holds for the @cf stream shape
      expect(
        nativeEvents.find((event) => event.type === "events.iterate.com/agent/llm-request-settled")!
          .payload,
      ).toMatchObject({ result: { status: "succeeded", text: "A native streamed answer." } });

      const masked = itx.cd("/agents/masked-ai");
      const maskedAi = new DeferredResponsesAi();
      await masked.provide("itx.ai", maskedAi);
      await itx.agents.create("/agents/masked-ai");
      await onWorkersAi(masked, "gpt-5.6-terra");
      await masked.provide("itx.ai", null);
      await itx.agents.get("/agents/masked-ai").message("This must not reach the provider.");
      const maskedEvents = await until("the masked model failure", async () => {
        const all = await readAll(masked);
        return all.some((event) => event.type === "events.iterate.com/agent/llm-request-settled")
          ? all
          : undefined;
      });
      expect(maskedAi.calls).toBe(0);
      expect(
        maskedEvents.find((event) => event.type === "events.iterate.com/agent/llm-request-settled")!
          .payload,
      ).toMatchObject({ result: { status: "failed" } });

      const failed = itx.cd("/agents/failed-partner");
      const failedAi = new FailedResponsesAi();
      await failed.provide("itx.ai", failedAi);
      await itx.agents.create("/agents/failed-partner");
      await onWorkersAi(failed, "gpt-5.6-terra");
      await itx.agents.get("/agents/failed-partner").message("This must report provider failure.");
      const failedEvents = await until("the partner HTTP failure settlement", async () => {
        const all = await readAll(failed);
        return all.some((event) => event.type === "events.iterate.com/agent/llm-request-settled")
          ? all
          : undefined;
      });
      expect(failedAi.calls).toBe(1);
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
      const nullBodyAi = new NullBodyResponsesAi();
      await nullBody.provide("itx.ai", nullBodyAi);
      await itx.agents.create("/agents/null-body-partner");
      await onWorkersAi(nullBody, "gpt-5.6-terra");
      await itx.agents.get("/agents/null-body-partner").message("This has no provider body.");
      const nullBodyEvents = await until("the null-body partner failure", async () => {
        const all = await readAll(nullBody);
        return all.some((event) => event.type === "events.iterate.com/agent/llm-request-settled")
          ? all
          : undefined;
      });
      expect(nullBodyAi.calls).toBe(1);
      expect(
        nullBodyEvents.find(
          (event) => event.type === "events.iterate.com/agent/llm-request-settled",
        )!.payload,
      ).toMatchObject({
        result: { status: "failed", errorMessage: "openai/gpt-5.6-terra 204: " },
      });

      const failedSse = itx.cd("/agents/failed-sse-partner");
      const failedSseAi = new FailedSseThenMoreResponsesAi();
      await failedSse.provide("itx.ai", failedSseAi);
      await itx.agents.create("/agents/failed-sse-partner");
      await onWorkersAi(failedSse, "gpt-5.6-terra");
      await itx.agents.get("/agents/failed-sse-partner").message("This must stop promptly.");
      const failedSseEvents = await until("the failed SSE settlement", async () => {
        const all = await readAll(failedSse);
        return all.some((event) => event.type === "events.iterate.com/agent/llm-request-settled")
          ? all
          : undefined;
      });
      expect(failedSseAi.calls).toBe(1);
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
    const worker = await startLoggedWorker();
    try {
      const itx = worker.itx(freshCtx("agent-transport-write-timeout"));
      const modelPath = "/agents/transport-write-timeout";
      await itx.cd(modelPath).provide("itx.ai", new OneChunkThenStallAi());
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
