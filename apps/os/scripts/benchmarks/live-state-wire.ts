/** Run with `pnpm --dir apps/os exec tsx scripts/benchmarks/live-state-wire.ts`.
 * Actual uncompressed Cap'n Web WebSocket messages, including array escaping.
 * Timings include local network scheduling; synchronous CPU is measured by live-state.ts.
 */
import { once } from "node:events";
import { appendText, sliceText } from "@iterate-com/shared/chunked-text";
import { WebSocketServer } from "ws";
import {
  createLiveStateStore,
  LiveState,
  LiveStateRpcTarget,
  newWebSocketRpcSession,
} from "iterate/sdk/capnweb";

async function benchmark(chunkSize: number, patchVersion: 2 | 3) {
  const size = 65536;
  let text = appendText("", "");
  const snapshot = () => ({
    agent: { live: { steps: [{ responseText: text }] } },
  });
  const engine = new LiveState(snapshot());
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  server.on("connection", (socket) => {
    // ws supplies the browser WebSocket methods used by this adapter, with
    // different DOM event declarations in its TypeScript interface.
    newWebSocketRpcSession(socket as unknown as WebSocket, new LiveStateRpcTarget(engine));
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing benchmark socket address");
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    let bytes = 0;
    const frameSizes: number[] = [];
    let firstPatch: string | undefined;
    socket.addEventListener("message", (event) => {
      const frame = String(event.data);
      // This deterministic fixture sends only state through callback pushes.
      // Count the whole Cap'n Web message, excluding RPC control messages.
      if (!frame.startsWith('["push",["pipeline",')) return;
      bytes += Buffer.byteLength(frame);
      frameSizes.push(Buffer.byteLength(frame));
      if (frameSizes.length === 2) firstPatch = frame;
    });
    using remote = newWebSocketRpcSession<LiveStateRpcTarget<ReturnType<typeof snapshot>>>(socket);
    const store = createLiveStateStore<ReturnType<typeof snapshot>>();
    let applied = Promise.withResolvers<void>();
    let sealedGroup: object | undefined;
    using subscription = await remote.subscribe(
      (update) => {
        store.apply(update, () => {
          throw new Error("Unexpected benchmark revision gap");
        });
        const current = store.getState()!.agent.live.steps[0]!.responseText;
        if (current.length >= 32768 && sealedGroup === undefined) sealedGroup = current.groups[0];
        if (current.length > 32768 && current.groups[0] !== sealedGroup)
          throw new Error("Sealed group replaced");
        applied.resolve();
      },
      { patchVersion },
    );
    const started = performance.now();
    for (let offset = 0; offset < size; offset += chunkSize) {
      applied = Promise.withResolvers<void>();
      text = appendText(text, "x".repeat(Math.min(chunkSize, size - offset)));
      engine.setState(snapshot());
      engine.readSince(); // force a flush per append, without debounce hiding cost
      await applied.promise;
    }
    const elapsedMs = performance.now() - started;
    if (sliceText(store.getState()!.agent.live.steps[0]!.responseText) !== "x".repeat(size)) {
      throw new Error("Benchmark text was lost or duplicated");
    }
    await subscription.unsubscribe();
    frameSizes.sort((a, b) => a - b);
    return {
      size,
      chunkSize,
      patchVersion,
      bytes,
      frames: frameSizes.length,
      meanFrameBytes: bytes / frameSizes.length,
      p95FrameBytes: frameSizes[Math.floor(frameSizes.length * 0.95)],
      elapsedMs,
      firstPatch,
    };
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const results = [];
for (const version of [2, 3] as const) {
  for (const chunkSize of [16, 48, 128, 1024]) results.push(await benchmark(chunkSize, version));
}
console.log(JSON.stringify(results, null, 2));
