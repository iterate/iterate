import { afterEach, describe, expect, test, vi } from "vitest";

import { openStream } from "./probe-audio.ts";
import { openWireCall } from "./wire-call.ts";

vi.mock("./probe-audio.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./probe-audio.ts")>();
  return {
    ...actual,
    openStream: vi.fn(),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
});

afterEach(() => vi.resetAllMocks());

describe("openWireCall", () => {
  test("reads durable terminal events through a fresh session after stop", async () => {
    const callbackDispose = vi.fn();
    const callbackClose = vi.fn();
    let terminalPayload: Record<string, unknown> | undefined;
    const writeStream = {
      append: vi.fn(async (...events: { payload: Record<string, unknown> }[]) => {
        terminalPayload = events.find(
          (event) => event.payload.reason === "script-complete",
        )?.payload;
      }),
      openConnection: vi.fn(async () => ({
        close: callbackClose,
        [Symbol.dispose]: callbackDispose,
      })),
    };
    const writeClose = vi.fn();
    const ended = () => ({
      offset: 3,
      type: "events.iterate.com/voice-agent/conversation-ended",
      createdAt: "2026-09-12T00:00:00.000Z",
      payload: terminalPayload,
    });
    const readStream = {
      getEvents: vi.fn(async () => [ended()]),
    };
    const readClose = vi.fn();
    /* These fixtures implement only the stream methods each phase calls;
     * Vitest cannot retain openStream's generic stream capability shape. */
    vi.mocked(openStream)
      .mockResolvedValueOnce({ stream: writeStream, close: writeClose } as never)
      .mockResolvedValueOnce({ stream: readStream, close: readClose } as never);

    const call = await openWireCall({ project: "proof", streamPath: "/voice" });
    await call.stop();
    await expect(call.durableEvents()).resolves.toEqual([ended()]);

    expect(callbackClose).toHaveBeenCalledOnce();
    expect(callbackDispose).toHaveBeenCalledOnce();
    expect(writeClose).toHaveBeenCalledOnce();
    expect(readStream.getEvents).toHaveBeenCalledOnce();
    expect(readClose).toHaveBeenCalledOnce();
  });

  test("does not append a second terminal after the call has already ended", async () => {
    let processEventBatch:
      | ((batch: { events?: { type: string; payload?: unknown }[] }) => void)
      | undefined;
    let connectionKey = "";
    const callbackDispose = vi.fn();
    const callbackClose = vi.fn();
    let sawLocalTerminal = false;
    const stream = {
      append: vi.fn(async (...events: { payload: Record<string, unknown> }[]) => {
        sawLocalTerminal ||= events.some((event) => event.payload.reason === "script-complete");
      }),
      openConnection: vi.fn(async (input) => {
        connectionKey = input.connectionKey;
        processEventBatch = input.processEventBatch;
        return { close: callbackClose, [Symbol.dispose]: callbackDispose };
      }),
    };
    const close = vi.fn();
    /* This live phase uses append/openConnection only; the mocked function's
     * generic capability type is unavailable after vi.mock(). */
    vi.mocked(openStream).mockResolvedValueOnce({ stream, close } as never);

    const call = await openWireCall({ project: "proof", streamPath: "/voice" });
    processEventBatch?.({
      events: [
        {
          type: "events.iterate.com/voice-agent/conversation-ended",
          payload: {
            activation: connectionKey.replace("wire-call-", ""),
            reason: "provider-ended",
          },
        },
      ],
    });
    await call.stop();

    expect(sawLocalTerminal).toBe(false);
    expect(callbackClose).toHaveBeenCalledOnce();
    expect(callbackDispose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  test("releases the project session when opening the callback fails", async () => {
    const close = vi.fn();
    const stream = { openConnection: vi.fn(async () => Promise.reject(new Error("open failed"))) };
    /* The rejection occurs before any other stream member is read, so this
     * fixture deliberately contains only openConnection. */
    vi.mocked(openStream).mockResolvedValueOnce({ stream, close } as never);

    await expect(openWireCall({ project: "proof", streamPath: "/voice" })).rejects.toThrow(
      "open failed",
    );

    expect(close).toHaveBeenCalledOnce();
  });
});
