// e2e/support/websocket-dialler.ts — an outbound WebSocket dialled by LOADED CODE with its plain
// `fetch` (its context's egress), `https://` plus `Upgrade: websocket`: workerd's fetch refuses a
// `wss://` URL. Against the deployed pet shop's gateways (apps/dummy-petshop src/gateway.ts), from
// secret-sockets.e2e.test.ts and instance-lends.e2e.test.ts.

/** `itx`'s loaded code dials `url` with `headers`; after the shop's hello it sends `identify` (when
 *  given), after the shop's dispatch a ping, and closes on the echo. The upgrade's status, the ops
 *  it saw and the close code (its own 1000, or the shop's); a refused upgrade's status and body. */
export function dialWebSocket(
  itx: any,
  url: string,
  headers: Readonly<Record<string, string | undefined>>,
  identify: string | null,
): Promise<unknown> {
  return itx.invoke([
    "itx",
    "workers",
    ["get", { source: SRC_DIALLER }],
    ["run", url, headers, identify],
  ]);
}

/** The dialler `dialWebSocket` loads, as a stateless worker of the context. */
const SRC_DIALLER = {
  "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Dialler extends WorkerEntrypoint {
  async run(url, headers, identify) {
    const response = await fetch(url, { headers: { ...headers, upgrade: "websocket" } });
    if (response.status !== 101 || !response.webSocket)
      return { status: response.status, body: (await response.text()).slice(0, 300) };
    const socket = response.webSocket;
    const ops = [];
    const close = new Promise((resolve) => {
      const timer = setTimeout(() => resolve("no close within 10 s"), 10_000);
      const done = (code) => { clearTimeout(timer); resolve(code); };
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(event.data);
        ops.push(frame.op);
        if (frame.op === "hello" && identify) socket.send(identify);
        if (frame.op === "dispatch") socket.send("ping");
        if (frame.op === "echo") { socket.close(1000, "done"); done(1000); }
      });
      socket.addEventListener("close", (event) => done(event.code));
    });
    socket.accept();
    return { status: 101, ops, close: await close };
  }
}`,
};
