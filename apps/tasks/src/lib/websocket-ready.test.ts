import { expect, test, vi } from "vitest";
import { waitForWebSocketOpen } from "./websocket-ready.ts";

test("waits for the browser WebSocket before RPC authentication starts", async () => {
  const socket = new ControllableSocket();
  const authenticate = vi.fn();

  const ready = waitForWebSocketOpen(socket).then(authenticate);
  await Promise.resolve();
  expect(authenticate).not.toHaveBeenCalled();

  socket.open();
  await ready;
  expect(authenticate).toHaveBeenCalledOnce();
});

test("surfaces a socket that closes before opening", async () => {
  const socket = new ControllableSocket();
  const ready = waitForWebSocketOpen(socket);

  socket.close();

  await expect(ready).rejects.toThrow("WebSocket closed before opening");
});

class ControllableSocket extends EventTarget {
  readyState = 0;

  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}
