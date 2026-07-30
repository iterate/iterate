import { describe, expect, test, vi } from "vitest";
import {
  connectGrokRealtimeVoice,
  type GrokWebSocketFactory,
} from "./grok-realtime-voice.ts";

class FakeWebSocket extends EventTarget {
  binaryType: BinaryType = "blob";
  readonly bufferedAmount = 0;
  readonly extensions = "";
  readonly protocol = "";
  readyState: number = WebSocket.CONNECTING;
  readonly sent: unknown[] = [];
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
  }

  open() {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
  }
}

describe("Grok realtime voice connector", () => {
  test("substitutes the server API key for a short-lived WebSocket credential", async () => {
    const requests: Request[] = [];
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        expires_at: 1_800_000_000,
        value: "xai-realtime-client-secret-test",
      });
    });
    let socket: FakeWebSocket | undefined;
    let protocols: string[] | undefined;
    const createWebSocket: GrokWebSocketFactory = (url, offeredProtocols) => {
      protocols = [...offeredProtocols];
      socket = new FakeWebSocket(url);
      queueMicrotask(() => socket?.open());
      return socket as unknown as WebSocket;
    };

    const connected = await connectGrokRealtimeVoice({
      apiKey: "xai-server-secret",
      createWebSocket,
      fetch: fetchImplementation,
      instructions: "Answer briefly.",
      sampleRateHz: 16_000,
      voice: "eve",
    });

    expect(connected).toBe(socket);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://api.x.ai/v1/realtime/client_secrets",
    );
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer xai-server-secret",
    );
    expect(protocols).toEqual([
      "xai-client-secret.xai-realtime-client-secret-test",
    ]);
    expect(socket?.url).toBe(
      "wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-2.0",
    );
    expect(socket?.url).not.toContain("xai-server-secret");
    expect(protocols?.join(",")).not.toContain("xai-server-secret");
    expect(socket?.binaryType).toBe("arraybuffer");
    expect(socket?.sent).toEqual([
      JSON.stringify({
        type: "session.update",
        session: {
          audio: {
            input: {
              format: { rate: 16_000, type: "audio/pcm" },
              transcription: { model: "grok-transcribe" },
              transport: "binary",
            },
            output: {
              format: { rate: 16_000, type: "audio/pcm" },
              transport: "binary",
            },
          },
          instructions: "Answer briefly.",
          turn_detection: { type: "server_vad" },
          voice: "eve",
        },
      }),
    ]);
  });

  test("configures manual turn detection for a push-to-talk device", async () => {
    let socket: FakeWebSocket | undefined;
    const connection = connectGrokRealtimeVoice({
      apiKey: "xai-server-secret",
      createWebSocket: (url) => {
        socket = new FakeWebSocket(url);
        queueMicrotask(() => socket?.open());
        return socket as unknown as WebSocket;
      },
      fetch: async () =>
        Response.json({
          expires_at: 1_800_000_000,
          value: "ephemeral-test",
        }),
      sampleRateHz: 16_000,
      turnDetection: "manual",
    });

    await connection;

    expect(socket?.sent).toHaveLength(1);
    expect(JSON.parse(String(socket?.sent[0]))).toMatchObject({
      session: {
        turn_detection: { type: null },
      },
      type: "session.update",
    });
  });

  test("classifies client-secret and WebSocket handshake failures without leaking secrets", async () => {
    await expect(
      connectGrokRealtimeVoice({
        apiKey: "never-print-this",
        createWebSocket: () => {
          throw new Error("must not dial after token failure");
        },
        fetch: async () => new Response("provider exploded", { status: 503 }),
        sampleRateHz: 16_000,
      }),
    ).rejects.toThrow("client credential request failed with status 503");

    let socket: FakeWebSocket | undefined;
    const connection = connectGrokRealtimeVoice({
      apiKey: "also-never-print-this",
      connectTimeoutMs: 20,
      createWebSocket: (url) => {
        socket = new FakeWebSocket(url);
        return socket as unknown as WebSocket;
      },
      fetch: async () =>
        Response.json({
          expires_at: 1_800_000_000,
          value: "ephemeral-test",
        }),
      sampleRateHz: 16_000,
    });

    await expect(connection).rejects.toThrow("WebSocket handshake timed out");
    expect(socket?.readyState).toBe(WebSocket.CLOSED);
    await expect(connection).rejects.not.toThrow("also-never-print-this");
  });
});
