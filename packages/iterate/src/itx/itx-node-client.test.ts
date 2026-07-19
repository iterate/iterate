import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  finishWebSocketRequestWithinDeadline,
  ItxWebSocketOpeningDeadlineError,
} from "./itx-node-client.ts";

class FakeOpeningRequest extends EventEmitter {
  readonly destroy = vi.fn();
  readonly end = vi.fn();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("node itx WebSocket opening deadline", () => {
  test("destroys a request whose DNS/socket/upgrade phase never settles", async () => {
    vi.useFakeTimers();
    const request = new FakeOpeningRequest();

    finishWebSocketRequestWithinDeadline(request, 15);
    expect(request.end).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(15);
    expect(request.destroy).toHaveBeenCalledOnce();
    expect(request.destroy.mock.calls[0]?.[0]).toBeInstanceOf(ItxWebSocketOpeningDeadlineError);
  });

  test("clears the absolute deadline when the request upgrades", async () => {
    vi.useFakeTimers();
    const request = new FakeOpeningRequest();

    finishWebSocketRequestWithinDeadline(request, 15);
    request.emit("upgrade");
    await vi.advanceTimersByTimeAsync(15);

    expect(request.destroy).not.toHaveBeenCalled();
  });
});
