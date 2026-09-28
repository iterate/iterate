// e2e/ai-stream-hung-request.e2e.test.ts — THE ROW that pins where an `itx.ai` stream is made.
//
// A Durable Object that reads Workers AI's raw streamed Response, returned over RPC from a second
// Durable Object through a stateless hop, gets the whole body, yet Cloudflare ends the stateless
// invocation in between with "The Workers runtime canceled this request because it detected that
// your Worker's code had hung and would never generate a response" (a standalone Worker with no
// Iterate code reproduces it; a Durable Object calling a stateless target that calls AI does not).
// So no context Durable Object holds the binding: the edge that took the call makes it
// (apps/os/src/context/dispatch.ts `ItxAiCall`). Here: a loaded facet calls `itx.ai.run` through
// `env.ITX` (ItxEntrypoint.get), its context resolves the call, ItxEntrypoint calls `env.AI.run`,
// and the facet drains the body itself, with no agents code. No caller sees the exception, so the
// verdict is the outcome of each ItxEntrypoint invocation that ran `ai.run`, read from Workers Logs
// (CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, Doppler os/preview). It pays for model calls, so
// only the real-model suite runs it (os-real-model.yml).
import { expect } from "vitest";
import { z } from "zod";
import { E2E_CI_RETRIES } from "@iterate-com/shared/test-support/e2e-policy";
import { createFailing } from "@iterate-com/shared/test-support/failing-test";
import { freshCtx, openItx, sleep } from "../../os/e2e/support/client.ts";
import { realModelOnly } from "../../os/e2e/support/project-host.ts";

/** Raw streams per run. One faults about 96% of the time (measured 2026-09-28), so three that all
 *  end `ok` by chance happen about once in 20,000 runs. */
const STREAMS = 3;
/** How long Workers Logs may take to show an invocation after it ended (under a minute, 2026-09-28). */
const LOGS_ARRIVE_MS = 120_000;

createFailing(realModelOnly, /hung and would never generate a response/, {
  timeoutMs: 240_000,
  retries: process.env.CI ? E2E_CI_RETRIES : 0,
})(
  "REAL: a loaded facet that drains itx.ai's raw streamed Response should leave the ItxEntrypoint invocation that answered it unfaulted",
  async () => {
    if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN)
      throw new Error(
        "the verdict is in Workers Logs: run under doppler --project os --config preview",
      );
    const itx = openItx(freshCtx("ai-stream-hung"));
    const from = Date.now() - 60_000; // a minute of slack for this machine's clock against Cloudflare's
    let contextId = "";
    for (let stream = 0; stream < STREAMS; stream++) {
      const drained = await itx.invoke([
        "itx",
        "facets",
        ["get", "streamer", { source: STREAMER_SOURCE, className: "StreamerDurableObject" }],
        ["stream"],
      ]);
      expect(drained).toMatchObject({ status: 200, completed: true });
      expect(drained.deltas).toBeGreaterThan(0);
      contextId = drained.contextId;
    }
    const invocations = await aiRunInvocations(contextId, from);
    console.log(`[ai-stream-hung] ${JSON.stringify(invocations)}`);
    const faulted = invocations.filter((invocation) => invocation.outcome !== "ok");
    if (faulted.length > 0)
      throw new Error(
        `${faulted.length} of ${STREAMS} ItxEntrypoint.get invocations faulted: ${faulted.map((invocation) => `${invocation.outcome} (${invocation.errors.join("; ")})`).join(", ")}`,
      );
  },
);

/** A facet that asks the default model for one word, streamed, the raw Response asked for as the
 *  agents ask for it, and drains the SSE body itself. */
const STREAMER_SOURCE = {
  "worker.js": `import { FacetDurableObject } from "iterate/sdk";
import { withItx } from "iterate/with-itx";
export class StreamerDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "stream"];
  async stream() {
    const response = await withItx(this.env.ITX, (itx) =>
      itx.ai.run(
        "openai/gpt-6-astra",
        { input: [{ role: "user", content: "Reply with the single word: pong" }], stream: true, store: false, reasoning: { effort: "low", summary: "auto" } },
        { returnRawResponse: true, gateway: { id: "default", skipCache: true } },
      ),
    );
    const decoder = new TextDecoder();
    let sse = "";
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sse += decoder.decode(value, { stream: true });
    }
    const types = [...sse.matchAll(/"type":"([a-z_.]+)"/g)].map((match) => match[1]);
    return {
      status: response.status,
      deltas: types.filter((type) => type === "response.output_text.delta").length,
      completed: types.includes("response.completed"),
      contextId: this.ctx.id.toString(), // a facet has its context Durable Object's id
    };
  }
}`,
};

const LogEvent = z.object({
  $workers: z.looseObject({
    entrypoint: z.string().optional(),
    outcome: z.string().optional(),
    event: z.looseObject({ rpcMethods: z.array(z.string()).optional() }).optional(),
  }),
  $metadata: z.looseObject({
    traceId: z.string(),
    requestId: z.string(),
    level: z.string().optional(),
    message: z.string().optional(),
  }),
});
type LogEvent = z.infer<typeof LogEvent>;

/** The STREAMS ItxEntrypoint invocations that ran `ai.run` for the context `contextId`, each with
 *  its outcome and the errors its request logged, once all of them and every faulted one's errors
 *  are in Workers Logs (an invocation's record and its exception arrive separately). They carry no
 *  Durable Object id, so they are found through the traces they share with the context's own
 *  invocations. A query Workers Logs fails (an HTML error page, a timeout) is asked again. */
async function aiRunInvocations(contextId: string, from: number) {
  const deadline = Date.now() + LOGS_ARRIVE_MS;
  let lastRead = "nothing yet";
  for (;;) {
    try {
      const traces = new Set(
        (await workersLogs("$workers.durableObjectId", contextId, from)).map(
          (event) => event.$metadata.traceId,
        ),
      );
      const events = (
        await Promise.all([...traces].map((trace) => workersLogs("$metadata.traceId", trace, from)))
      ).flat();
      const invocations = events
        .filter(
          (event) =>
            event.$workers.entrypoint === "ItxEntrypoint" &&
            event.$workers.event?.rpcMethods?.includes("ai.run"),
        )
        .map((invocation) => ({
          outcome: invocation.$workers.outcome,
          errors: events
            .filter(
              (event) =>
                event !== invocation &&
                event.$metadata.requestId === invocation.$metadata.requestId &&
                event.$metadata.level === "error",
            )
            .map((event) => event.$metadata.message),
        }));
      const complete = invocations.every(
        ({ outcome, errors }) => outcome === "ok" || errors.length > 0,
      );
      if (invocations.length >= STREAMS && complete) return invocations;
      lastRead = `${invocations.length} of ${STREAMS}: ${JSON.stringify(invocations)}`;
    } catch (error) {
      lastRead = `Workers Logs failed: ${String(error)}`;
    }
    if (Date.now() > deadline)
      throw new Error(
        `the ItxEntrypoint invocations that ran ai.run were not all in Workers Logs after ${LOGS_ARRIVE_MS / 1000} s: ${lastRead}`,
      );
    await sleep(5_000);
  }
}

/** The preview account's Workers Logs events since `from` whose `key` equals `value`. */
async function workersLogs(key: string, value: string, from: number): Promise<LogEvent[]> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/observability/telemetry/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        queryId: "ai-stream-hung-request",
        view: "events",
        limit: 100,
        timeframe: { from, to: Date.now() },
        parameters: {
          datasets: ["cloudflare-workers"],
          filters: [{ key, operation: "eq", type: "string", value }],
        },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const answer = z
    .object({
      success: z.boolean(),
      errors: z.unknown(),
      result: z.object({ events: z.object({ events: z.array(LogEvent) }).optional() }).optional(),
    })
    .parse(await response.json());
  if (!answer.success)
    throw new Error(`Workers Logs answered ${response.status}: ${JSON.stringify(answer.errors)}`);
  return answer.result?.events?.events || [];
}
