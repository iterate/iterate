import { describe, expect, test, vi } from "vitest";
import { aecFixturePcmEvidence, openAecFixtureTransport } from "./aec-fixture-transport.ts";

describe("AEC fixture transport", () => {
  test("uses device-observed socket evidence for Captun and bridge evidence only for LAN", () => {
    /*
     * Captun handles Fetch WebSocketPairs directly; it never creates the
     * TCP-to-Fetch bridge instrumented by LocalFetchWebSocketServer. An empty
     * invented bridge history previously made every tunneled run report an
     * unknown terminal socket even while device counters and PCM progressed.
     */
    const common = {
      bridgeCloseEvents: [],
      bridgeOpenEvents: [],
      progress: { deviceToWorkerBytes: 640, workerToDeviceBytes: 640 },
    };
    expect(aecFixturePcmEvidence({ ...common, transportKind: "captun" })).toEqual({
      kind: "device-observed",
      progress: common.progress,
    });
    expect(aecFixturePcmEvidence({ ...common, transportKind: "direct-lan" })).toEqual({
      bridgeEvidence: { closeEvents: [], historyTruncated: false, openEvents: [] },
      kind: "local-bridge",
      progress: common.progress,
    });
  });

  test("puts the exact authenticated fixture fetch handler behind Captun by default", async () => {
    const fetch = vi.fn(() => new Response("fixture"));
    const dispose = vi.fn();
    const createTunnel = vi.fn(async (options: unknown) => ({
      [Symbol.dispose]: dispose,
      url: "https://bounded-aec.tunnels.iterate.com",
    }));

    const transport = await openAecFixtureTransport(
      {
        fetch,
        gateway: "https://tunnels.iterate.com",
        token: "bounded-test-token",
        tunnelName: "bounded-aec",
      },
      { createTunnel },
    );

    expect(createTunnel).toHaveBeenCalledWith({
      fetch,
      gateway: "https://tunnels.iterate.com",
      name: "bounded-aec",
      token: "bounded-test-token",
    });
    expect(transport).toMatchObject({
      baseUrl: "https://bounded-aec.tunnels.iterate.com",
      kind: "captun",
    });
    await transport.close();
    expect(dispose).toHaveBeenCalledOnce();
  });

  test("rejects a public fixture without bounded gateway authentication", async () => {
    await expect(
      openAecFixtureTransport({
        fetch: () => new Response("fixture"),
        gateway: "https://tunnels.iterate.com",
        token: "   ",
      }),
    ).rejects.toThrow(/CAPTUN_TOKEN/u);
  });

  test("uses direct LAN only when explicitly selected and closes it asynchronously", async () => {
    const fetch = vi.fn(() => new Response("fixture"));
    const close = vi.fn(async () => undefined);
    const listenDirect = vi.fn(async (options: unknown) => ({
      baseUrl: "http://192.168.0.10:34567",
      close,
    }));

    const transport = await openAecFixtureTransport(
      {
        directLan: {
          host: "192.168.0.10",
          port: 34_567,
        },
        fetch,
        gateway: "https://unused.invalid",
        token: undefined,
      },
      { listenDirect },
    );

    expect(listenDirect).toHaveBeenCalledWith({
      fetch,
      host: "192.168.0.10",
      port: 34_567,
    });
    expect(transport.kind).toBe("direct-lan");
    await transport.close();
    expect(close).toHaveBeenCalledOnce();
  });

  test("makes cleanup idempotent so failure paths cannot double-dispose a tunnel", async () => {
    const dispose = vi.fn();
    const transport = await openAecFixtureTransport(
      {
        fetch: () => new Response("fixture"),
        gateway: "https://tunnels.iterate.com",
        token: "bounded-test-token",
      },
      {
        createTunnel: async () => ({
          [Symbol.dispose]: dispose,
          url: "https://once.tunnels.iterate.com",
        }),
      },
    );

    await transport.close();
    await transport.close();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
