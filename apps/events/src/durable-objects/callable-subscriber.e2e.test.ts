import { randomUUID } from "node:crypto";
import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

describe("stream callable subscriber e2e", () => {
  it("lets a callable subscriber append a bounded event chain back into the same stream", async () => {
    /**
     * This is intentionally a Miniflare/workerd e2e test rather than a mocked
     * unit test. The bug we are pinning down is not "does an object call a
     * function in a loop"; it is specifically the Cloudflare runtime call graph
     * created by a StreamDurableObject dispatching a Workers RPC callable
     * subscriber which then gets a STREAM Durable Object stub and appends back
     * into the same stream.
     *
     * The production failure looked like this:
     *
     *   StreamDurableObject.append(tick 1)
     *     -> external subscriber processor dispatches Workers RPC callable
     *       -> E2EAppendChainSubscriber.afterAppend(tick 1)
     *         -> this.env.STREAM.get(...).append(tick 2)
     *           -> StreamDurableObject.afterAppend(tick 2)
     *             -> dispatches the same callable subscriber again
     *               -> E2EAppendChainSubscriber.afterAppend(tick 2)
     *                 -> this.env.STREAM.get(...).append(tick 3)
     *                   -> ...
     *
     * If subscriber delivery runs synchronously inside `append()`, all of those
     * Worker-to-Worker RPC invocations remain inside one request chain. On
     * Cloudflare this eventually exhausts the Worker-to-Worker subrequest depth
     * limit. In the full codemode/MCP path, the same root cause has two visible
     * symptoms:
     *
     * - If the depth exception is caught and serialized into a stream event,
     *   the MCP client gets an error result containing "Subrequest depth limit
     *   exceeded".
     * - If the recursive delivery chain stalls before the codemode completion
     *   event is appended, the MCP client instead waits until its request or SDK
     *   timeout fires. That timeout is not a separate root cause; it is another
     *   externally visible outcome of the same synchronous subscriber chain.
     *
     * The desired stream behavior is modest: callable subscriber delivery may
     * append more events, and those events may trigger the same subscriber
     * again, but the stream DO must break the runtime call chain between each
     * committed event. The planned fix is to enqueue callable subscriber
     * delivery onto the stream DO alarm handler. Alarms run in a fresh Durable
     * Object event, which should turn this from one deeply nested request chain
     * into a sequence of shallow calls.
     *
     * The test uses a bounded chain (`max`) so runaway loops are impossible.
     * As of this repro, Miniflare/workerd's local vitest runner completes the
     * chain even before the deployed-runtime alarm fix. That difference is
     * important evidence: local Miniflare is useful for guarding the intended
     * behavior after the fix, but the preview network e2e is the red test for
     * Cloudflare's deployed subrequest-depth behavior. Keep this local max
     * below the preview max so root `pnpm test` does not depend on a long alarm
     * scheduling race while still exercising repeated alarm-delivered appends.
     */
    const chainId = randomUUID();
    const max = 50;
    const startUrl = new URL("https://example.com/__e2e/callable-subscriber-chain");
    startUrl.searchParams.set("action", "start");
    startUrl.searchParams.set("chainId", chainId);
    startUrl.searchParams.set("max", String(max));

    const startResponse = await SELF.fetch(startUrl);
    expect(startResponse.status).toBe(200);

    await vi.waitFor(
      async () => {
        const statusUrl = new URL("https://example.com/__e2e/callable-subscriber-chain");
        statusUrl.searchParams.set("action", "status");
        statusUrl.searchParams.set("chainId", chainId);
        statusUrl.searchParams.set("max", String(max));

        const statusResponse = await SELF.fetch(statusUrl);
        expect(statusResponse.status).toBe(200);
        const status = (await statusResponse.json()) as {
          ticks: Array<{ payload: { count: number } }>;
        };

        expect(status.ticks.map((event) => event.payload.count)).toEqual(
          Array.from({ length: max }, (_, index) => index + 1),
        );
      },
      {
        interval: 100,
        timeout: 10_000,
      },
    );
  });
});
