import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
  tracing: {
    enterSpan: (_name: string, fn: (span: { setAttribute: () => void }) => unknown) =>
      fn({ setAttribute: () => {} }),
  },
}));

import { makeProcessorHarness } from "iterate/processors/testing";
import { VoiceAgentContract, VoiceAgentProcessor } from "./voice-agent.ts";

describe("VoiceAgentProcessor delivery", () => {
  it("does not acknowledge a PTT whose required call-started append fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let resolveDial: ((socket: WebSocket) => void) | undefined;
    let resolveClosed: (() => void) | undefined;
    const socketClose = vi.fn(() => resolveClosed?.());
    /* Only close() is reachable: the failed append has displaced this dial
     * before its provider promise resolves. */
    const socket = { close: socketClose } as unknown as WebSocket;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const h = makeProcessorHarness<typeof VoiceAgentContract, VoiceAgentProcessor>({
      createProcessor: (deps) =>
        new VoiceAgentProcessor({
          ...deps,
          nowAtFacetMs: deps.now,
          buildCacheKey: "test",
          sleep: async () => {},
          dialProvider: () =>
            new Promise<WebSocket>((resolve) => {
              resolveDial = resolve;
            }),
          withProject: async (fn) => await fn({}),
        }),
    });
    h.stream.failAppendsOfType = "events.iterate.com/voice-agent/call-started";

    try {
      await expect(
        h.append({
          type: "events.iterate.com/voice-agent/ptt-start",
          payload: { t: 1, client: "/clients/test" },
        }),
      ).rejects.toThrow("injected append failure");
      expect(h.events("events.iterate.com/voice-agent/call-started")).toEqual([]);
      expect(resolveDial).toBeTypeOf("function");
      resolveDial?.(socket);
      await closed;
      expect(socketClose).toHaveBeenCalledOnce();
    } finally {
      consoleError.mockRestore();
    }
  });
});
