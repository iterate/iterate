/*
 * WHICH PROVIDER THIS STREAM DIALS, AND WHAT TRAVELS WITH THE DIAL.
 *
 * The endpoint used to be a constant, and the comment explaining why said the
 * quiet part: a caller-chosen base URL is a bearer token waiting to follow it
 * somewhere it should not go. Making it configurable for tests reopens exactly
 * that hole unless the credential rule is independent of who set the URL — so
 * that rule is asserted here first, and directly.
 */
import { describe, expect, it, vi } from "vitest";
import { makeProcessorHarness } from "iterate/processors/testing";
import {
  birthCertificateKey,
  dialGrokSocket,
  VoiceAgentFacetContract,
  VoiceAgentFacetProcessor,
} from "./voice-agent.ts";

const CREATED = "events.iterate.com/voice-agent/created";
const PTT_START = "events.iterate.com/voice-agent/ptt-start";

/**
 * A socket that stays up and says nothing.
 *
 * It has to actually stay OPEN. A dial that refuses the upgrade makes the
 * facet write `conversation-failed`, which closes the call in the fold — and
 * then there is no open call for a revived incarnation to recover, so the
 * eviction test below would pass vacuously by never re-dialling at all.
 */
function quietSocket(): WebSocket {
  return {
    readyState: 1,
    addEventListener() {},
    send() {},
    close() {},
  } as unknown as WebSocket;
}

/** A dial that records where it was pointed instead of going anywhere. */
function harnessRecordingDials(socket: () => WebSocket | null = quietSocket) {
  const dialled: (string | null)[] = [];
  const harness = makeProcessorHarness<VoiceAgentFacetContract, VoiceAgentFacetProcessor>({
    path: "/agents/voice/provider-url",
    createProcessor: (deps) =>
      new VoiceAgentFacetProcessor({
        ...deps,
        now: deps.now,
        dialGrok: async (baseUrl) => {
          dialled.push(baseUrl);
          return socket();
        },
      }),
  });
  return { harness, dialled };
}

describe("the credential never follows a caller-chosen URL", () => {
  /**
   * Capture the one `fetch` the dial makes, and answer it with no socket.
   *
   * Asserting on the REQUEST is the whole point: a test that only checked the
   * returned socket would pass just as happily while the key went to the
   * attacker's host.
   */
  async function dialAndCaptureHeaders(baseUrl: string | null) {
    const fetchMock = vi.fn(async () => ({ webSocket: null }) as unknown as Response);
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await dialGrokSocket(baseUrl);
    } finally {
      globalThis.fetch = original;
    }
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    return { url, headers: init.headers };
  }

  it("sends the key to x.ai, which is the only host that may have it", async () => {
    const { url, headers } = await dialAndCaptureHeaders(null);
    expect(url).toContain("api.x.ai");
    expect(headers.Authorization).toContain("getSecret");
  });

  it("sends NO key to a mock, however the URL got there", async () => {
    const { url, headers } = await dialAndCaptureHeaders("http://127.0.0.1:8787/v1/realtime");
    expect(url).toContain("127.0.0.1");
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain("getSecret");
  });

  it("sends NO key to a host merely PRETENDING to be x.ai", async () => {
    /*
     * The rule is host equality, not a substring. `api.x.ai.evil.com` and
     * `notapi.x.ai` both read as x.ai to a careless check, and either would be
     * a credential handed to whoever registered the domain.
     */
    for (const host of [
      "https://api.x.ai.evil.com/v1/realtime",
      "https://x.ai.attacker.test/v1/realtime",
      "https://evil.com/?a=api.x.ai",
    ]) {
      const { headers } = await dialAndCaptureHeaders(host);
      expect(headers.Authorization, `leaked to ${host}`).toBeUndefined();
    }
  });

  it("still trusts a real x.ai subdomain", async () => {
    const { headers } = await dialAndCaptureHeaders("https://eu.x.ai/v1/realtime");
    expect(headers.Authorization).toContain("getSecret");
  });
});

describe("the birth certificate says which provider", () => {
  it("dials x.ai when nothing says otherwise", async () => {
    const { harness, dialled } = harnessRecordingDials();
    await harness.append({ type: CREATED, payload: {} });
    await harness.append({ type: PTT_START, payload: {} });
    await harness.settle();
    expect(dialled).toEqual([null]);
  });

  it("dials the mock the birth certificate names", async () => {
    const { harness, dialled } = harnessRecordingDials();
    await harness.append({
      type: CREATED,
      payload: { providerBaseUrl: "http://127.0.0.1:9999/v1/realtime" },
    });
    await harness.append({ type: PTT_START, payload: {} });
    await harness.settle();
    expect(dialled).toEqual(["http://127.0.0.1:9999/v1/realtime"]);
  });

  it("still dials the mock after an eviction", async () => {
    /*
     * THE INCARNATION THAT NEEDS IT MOST IS THE ONE THAT NEVER SAW THE EVENT.
     *
     * A revived facet dials from the at-head pass, having missed everything
     * that came before. Held in a field, the override would be empty exactly
     * there and the re-dial would go to x.ai — a test that had carefully
     * pointed everything at a mock would silently reach the real provider
     * halfway through. Reading it from the FOLD is what makes that impossible.
     */
    const { harness, dialled } = harnessRecordingDials();
    await harness.append({
      type: CREATED,
      payload: { providerBaseUrl: "http://127.0.0.1:9999/v1/realtime" },
    });
    await harness.append({ type: PTT_START, payload: {} });
    await harness.settle();
    dialled.length = 0;

    /* Eleven seconds, because the thing that revives a dead incarnation is the
     * keepalive alarm the held call armed, and it re-arms on a ten-second
     * lead. A shorter wait proves nothing: nobody has woken up yet. */
    harness.crash();
    await harness.advanceTime(11_000);
    await harness.settle();

    expect(dialled.length).toBeGreaterThan(0);
    expect(dialled.every((at) => at === "http://127.0.0.1:9999/v1/realtime")).toBe(true);
  });
});

describe("pointing a stream BACK at a provider it has used before", () => {
  /*
   * THE BUG THIS NAMES, WHICH IS THE BRIEF'S BUG ONE FIELD OVER.
   *
   * `setupVoiceAgent` appends the birth certificate under an idempotency key,
   * and the key used to be derived from the certificate's own CONTENT. The
   * platform deduplicates on it, so the third setup below appended nothing at
   * all: the key was the one the FIRST setup used, the event it named was
   * already on the stream, and the newest `created` the fold saw stayed the
   * MOCK's. A run that asked for the real provider then dialled a captun
   * tunnel that had been closed for an hour, and said nothing about it.
   *
   * Exactly the failure the comment above `ensureVoiceAgent` describes for the
   * brief — "a prompt that changed and then changed BACK did not reinstall" —
   * and the fix is the same one: an occurrence per setup, keyed on the
   * setup's own identity, so nothing is ever deduplicated against a decision
   * somebody has since changed twice.
   */
  it("is a change, not a no-op: every setup writes its own birth certificate", () => {
    const path = "/agents/voice/waveshare";
    const mock = { providerBaseUrl: "https://a1b2.tunnels.iterate.com/v1/realtime" };
    /* Point it at a mock, then at x.ai, then at a second mock, then back at
     * x.ai — the exact sequence a morning of hardware runs produces. */
    const keys = [
      birthCertificateKey(path, mock, "setup-1"),
      birthCertificateKey(path, {}, "setup-2"),
      birthCertificateKey(path, { providerBaseUrl: "https://c3d4.tunnels…" }, "setup-3"),
      birthCertificateKey(path, {}, "setup-4"),
    ];
    expect(new Set(keys).size, `deduplicated: ${keys.join(", ")}`).toBe(keys.length);
  });

  it("keeps the stream in the key, so two streams cannot share a certificate", () => {
    expect(birthCertificateKey("/agents/voice/waveshare", {}, "s")).not.toBe(
      birthCertificateKey("/agents/voice/stackchan", {}, "s"),
    );
  });

  it("dials whichever birth certificate is NEWEST", async () => {
    /* The fold half of the same claim: given both events, the later one wins.
     * It always did — which is why the deduplicated append was invisible. */
    const { harness, dialled } = harnessRecordingDials();
    await harness.append({
      type: CREATED,
      payload: { providerBaseUrl: "http://127.0.0.1:9999/v1/realtime" },
    });
    await harness.append({ type: CREATED, payload: {} });
    await harness.append({ type: PTT_START, payload: {} });
    await harness.settle();
    expect(dialled).toEqual([null]);
  });
});
