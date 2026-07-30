import { afterEach, describe, expect, test } from "vitest";
import {
  createDualCarrierPrbs31Challenge,
  renderDualCarrierPrbs31Pcm16,
} from "../device/acoustic-prbs31-challenge.ts";
import { DeterministicPcmPrbs31Provider } from "./deterministic-pcm-prbs31-provider.ts";

describe("deterministic PCM PRBS31 provider", () => {
  const providers: DeterministicPcmPrbs31Provider[] = [];

  afterEach(() => {
    for (const provider of providers.splice(0)) provider[Symbol.dispose]();
  });

  test("preserves one run-keyed source timeline across inconvenient WebSocket chunks", async () => {
    /*
     * A constant tone can prove that sound existed, but not which part of the
     * provider timeline reached the speaker. That ambiguity matters for the
     * current physical failure: ten seconds entered the device while only
     * eight seconds were acoustically identifiable. This regression forces the
     * physical diagnostic source through odd 1,000-byte boundaries and proves
     * that neither provider pacing nor chunk conversion restarts its PRBS
     * state. A later missing acoustic prefix can therefore implicate a real
     * downstream boundary rather than the challenge generator itself.
     */
    const challenge = createDualCarrierPrbs31Challenge({
      runId: "physical-startup-localisation",
    });
    const provider = new DeterministicPcmPrbs31Provider({
      challenge,
      chunkBytes: 1_000,
      durationMs: 100,
    });
    providers.push(provider);
    const socket = await provider.connect();
    const messages: MessageEvent[] = [];
    const complete = Promise.withResolvers<void>();
    socket.addEventListener("message", (event) => {
      messages.push(event);
      if (typeof event.data === "string" && JSON.parse(event.data).type === "response.done") {
        complete.resolve();
      }
    });

    socket.send(JSON.stringify({ type: "response.create" }));
    await complete.promise;

    const controls = messages
      .filter((message) => typeof message.data === "string")
      .map((message) => JSON.parse(String(message.data)).type);
    const chunks = messages
      .filter((message) => typeof message.data !== "string")
      .map((message) => new Uint8Array(message.data as ArrayBufferLike));
    const actual = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      actual.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const expectedSamples = renderDualCarrierPrbs31Pcm16({
      challenge,
      chunkSamples: 173,
      durationMs: 100,
    });
    const expected = new Uint8Array(expectedSamples.byteLength);
    const expectedView = new DataView(expected.buffer);
    for (let index = 0; index < expectedSamples.length; index += 1) {
      expectedView.setInt16(index * 2, expectedSamples[index]!, true);
    }

    expect(controls).toEqual(["response.created", "response.done"]);
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([1_000, 1_000, 1_000, 200]);
    expect(actual).toEqual(expected);
  });
});
