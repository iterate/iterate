import { randomBytes } from "node:crypto";
import { RpcTarget, upgradeWebSocketResponse, WebSocketPair } from "capnweb";
import WebSocket from "ws";
import type { IterateConnection } from "iterate/node";

/** Headers the local dial makes itself: undici throws on the hop-by-hop ones, and `host` must be
 *  localhost's (Vite's `allowedHosts` refuses any other). */
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "host",
];

/** THE TUNNEL'S LENT STUB: every request the project's host routes here, proxied to
 *  `http://localhost:<port>` — method, headers, streamed body, redirects handed back as they are.
 *  A WebSocket upgrade dials the local server with the visitor's subprotocols and pumps frames both
 *  ways. Nothing listening is a 502 naming the port. */
export class LocalPortRpcTarget extends RpcTarget {
  readonly #port: number;
  readonly #log: (line: string) => void;

  constructor(port: number, log: (line: string) => void = () => {}) {
    super();
    this.#port = port;
    this.#log = log;
  }

  async fetch(request: Request): Promise<Response> {
    const visitorUrl = new URL(request.url);
    // Under paths routing the edge strips `/projects/<project>/<slug>` and names it here: this
    // sends the visitor's own path, which a server under that base (Vite: `--base`) expects.
    const basePath = request.headers.get("x-iterate-base-path") || "";
    // Set piecewise, never joined as a string: a path of `//other-host/` must stay a path on
    // localhost, never become a destination.
    const localUrl = new URL(`http://localhost:${this.#port}`);
    localUrl.pathname = `${basePath}${visitorUrl.pathname}`;
    localUrl.search = visitorUrl.search;
    const headers = new Headers(request.headers);
    for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
    if ((request.headers.get("upgrade") ?? "").toLowerCase() === "websocket")
      return this.#upgradeWebSocket(request, localUrl, headers);
    let response: Response;
    try {
      response = await fetch(localUrl, {
        method: request.method,
        headers,
        body: request.body,
        // a streamed request body needs half duplex (undici), which the DOM's RequestInit type
        // does not declare — hence the cast
        duplex: "half",
        redirect: "manual",
      } as RequestInit);
    } catch (error) {
      this.#log(
        `${request.method} ${localUrl.pathname}${localUrl.search} → 502 (${causeOf(error)})`,
      );
      return new Response(`Nothing answered on localhost:${this.#port} (${causeOf(error)})\n`, {
        status: 502,
      });
    }
    this.#log(`${request.method} ${localUrl.pathname}${localUrl.search} → ${response.status}`);
    // Node's fetch always decodes a compressed body, so its encoding and length no longer hold
    const responseHeaders = new Headers(response.headers);
    if (responseHeaders.has("content-encoding")) {
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  }

  /** The local server's WebSocket, bridged through a `WebSocketPair`: the pair buffers what the
   *  server says before the visitor's side is wired (Vite's HMR server greets at once). */
  async #upgradeWebSocket(request: Request, localUrl: URL, headers: Headers): Promise<Response> {
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((protocol) => protocol.trim())
      .filter(Boolean);
    localUrl.protocol = "ws:";
    const pair = new WebSocketPair();
    const visitorSide = pair[1];
    // accepted first: a half sends only once accepted, and the local server may speak the moment
    // it opens; the visitor's half buffers until the visitor accepts it
    visitorSide.accept();
    const localHeaders: Record<string, string> = {};
    // the handshake's own headers are the local dial's to make
    headers.forEach((value, name) => {
      if (!name.startsWith("sec-websocket-")) localHeaders[name] = value;
    });
    const local = new WebSocket(localUrl, protocols, { headers: localHeaders });
    local.on("message", (data, isBinary) => {
      // ws's default binaryType, nodebuffer, delivers every message as one Buffer
      const buffer = data as Buffer;
      try {
        visitorSide.send(isBinary ? new Uint8Array(buffer) : buffer.toString());
      } catch {
        /* the visitor's side is closing; its close tears the bridge down */
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        local.once("open", resolve);
        local.once("error", reject);
        local.once("unexpected-response", (_request, response) =>
          reject(new Error(`the local server answered ${response.statusCode}`)),
        );
      });
    } catch (error) {
      visitorSide.close(1011, "no local WebSocket");
      this.#log(`WS ${localUrl.pathname} → 502 (${causeOf(error)})`);
      return new Response(
        `No WebSocket answered on localhost:${this.#port} (${causeOf(error)})\n`,
        { status: 502 },
      );
    }
    this.#log(`WS ${localUrl.pathname} → 101${local.protocol ? ` (${local.protocol})` : ""}`);
    visitorSide.addEventListener(
      "message",
      (event: { data: string | ArrayBuffer | Uint8Array }) => {
        if (local.readyState === WebSocket.OPEN) local.send(event.data);
      },
    );
    visitorSide.addEventListener("close", (event: { code?: number; reason?: string }) => {
      local.close(sendableCloseCode(event.code), event.reason);
    });
    local.on("close", (code, reason) => {
      try {
        visitorSide.close(sendableCloseCode(code), reason.toString());
      } catch {
        /* already closing */
      }
    });
    local.on("error", () => {
      try {
        visitorSide.close(1011, "the local WebSocket failed");
      } catch {
        /* already closing */
      }
    });
    return upgradeWebSocketResponse(pair[0], {
      headers: local.protocol ? { "Sec-WebSocket-Protocol": local.protocol } : {},
    });
  }
}

/** A close code a WebSocket may send: the ones only a runtime reports (1005 none, 1006 abnormal,
 *  1015 TLS) and anything out of range become 1000. */
function sendableCloseCode(code: number | undefined): number {
  if (code === undefined) return 1000;
  if (code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014))
    return code;
  return code >= 3000 && code <= 4999 ? code : 1000;
}

/** undici hides the reason a dial failed (ECONNREFUSED) in `cause`. */
function causeOf(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  return cause?.code || cause?.message || (error instanceof Error ? error.message : String(error));
}

/** How long the tunnel waits before each attempt to reconnect after its connection closed, about
 *  five minutes in all: long enough for Wi-Fi to come back or a laptop to wake, short enough that a
 *  tunnel whose network is gone for good says so and exits. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, ...Array(9).fill(30_000)];

/** `iterate tunnel <port>`: lend a `LocalPortRpcTarget` to the project as `itx.tunnels.<slug>`, set
 *  the fetch route `tunnel-<slug>` taking the `<slug>` host to it, print the URL on stdout, and on
 *  Ctrl-C delete the route, then end the lend. A connection that closes (its heartbeat found it dead,
 *  iterate/node) is replaced: `reconnect` opens a fresh one and the tunnel lends and routes again
 *  over it, the same name taking its own route over. Only when every attempt fails does the tunnel
 *  end, with an error. */
export async function runTunnel(input: {
  connection: IterateConnection;
  reconnect: () => Promise<IterateConnection>;
  project: string;
  port: number;
  routingSlug?: string;
  public?: boolean;
  /** the reconnect schedule — a test's, `RECONNECT_DELAYS_MS` otherwise */
  reconnectDelaysMs?: readonly number[];
}): Promise<void> {
  const routingSlug = input.routingSlug || `t${randomBytes(4).toString("hex")}`;
  const fetchRouteName = `tunnel-${routingSlug}`;
  const target = `itx.tunnels.${routingSlug}`;
  // Listening before the route is set: until a listener is installed the OS's default action ends
  // the process at once, which would leave the route standing.
  let stop = () => {};
  const stopped = new Promise<"stopped">((resolve) => (stop = () => resolve("stopped")));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  /** Serve over one connection until Ctrl-C (the route deleted) or until the connection closes. */
  const serve = async (
    connection: IterateConnection,
    first: boolean,
  ): Promise<"stopped" | { code: number; reason: string }> => {
    using project = await connection.session.projects.get(input.project);
    // A route of this name or on this host is someone else's unless it is this tunnel's own (a
    // restart, another terminal, this tunnel before it reconnected), which is taken over.
    const conflict = (await project.fetchRoutes.list()).find(
      (route) =>
        (route.fetchRouteName === fetchRouteName ||
          route.requestMatcher.routingSlug === routingSlug) &&
        !(route.fetchRouteName === fetchRouteName && route.target.join(".") === target),
    );
    if (conflict)
      throw new Error(
        `The fetch route ${conflict.fetchRouteName} (target ${conflict.target.join(".")}) already has this name or host. Pick another --name.`,
      );
    const url = await project.url({ routingSlug });
    using _lend = await project.provide(
      target,
      new LocalPortRpcTarget(input.port, (line) => console.error(line)),
    );
    await project.fetchRoutes.set(fetchRouteName, {
      requestMatcher: { routingSlug },
      target,
      authRequirement: input.public ? null : { visitors: "project-members" },
    });
    if (first) {
      console.log(url);
      console.error(
        `${url} → http://localhost:${input.port} (${input.public ? "public" : "project members only"}). Press Ctrl-C to stop.`,
      );
      const basePath = new URL(url).pathname;
      if (basePath !== "/")
        console.error(
          `Projects are served under paths here: your local server must serve under ${basePath} (Vite: --base ${basePath}). To serve at / on an origin of its own, give the deployment a domain with a wildcard certificate: https://github.com/iterate/iterate/blob/main/apps/os/SELF-HOSTING.md#custom-domain-own-origins-for-apps-and-tunnels`,
        );
    } else console.error(`Reconnected: ${url} → http://localhost:${input.port}`);
    const outcome = await Promise.race([stopped, connection.closed]);
    // the route first: the host stops answering the moment it is gone
    if (outcome === "stopped")
      await project.fetchRoutes.set(fetchRouteName, null).catch((error: unknown) => {
        console.error(`Could not delete the fetch route ${fetchRouteName}: ${messageOf(error)}`);
      });
    return outcome;
  };
  const delaysMs = input.reconnectDelaysMs || RECONNECT_DELAYS_MS;
  let connection: IterateConnection | null = input.connection;
  let lastFailure = "";
  try {
    for (let first = true, failures = 0; ; first = false) {
      if (connection) {
        try {
          const outcome = await serve(connection, first);
          if (outcome === "stopped") return;
          lastFailure = `${outcome.code}: ${outcome.reason || "connection closed"}`;
          console.error(`The tunnel disconnected (${lastFailure}). Reconnecting...`);
          failures = 0; // it was serving: a fresh round of attempts
        } catch (error) {
          if (first) throw error; // the first connection's refusal (a taken name) is the answer
          lastFailure = messageOf(error);
          console.error(`Could not serve the tunnel again: ${lastFailure}`);
        } finally {
          connection[Symbol.dispose]();
        }
      }
      const delayMs = delaysMs[failures++];
      if (delayMs === undefined)
        throw new Error(
          `The tunnel disconnected and could not reconnect (${lastFailure}). Run iterate tunnel again.`,
        );
      let wait: ReturnType<typeof setTimeout> | undefined;
      const waited = await Promise.race([
        stopped,
        new Promise<"waited">((resolve) => (wait = setTimeout(() => resolve("waited"), delayMs))),
      ]);
      clearTimeout(wait);
      if (waited === "stopped") return;
      connection = await input.reconnect().catch((error: unknown) => {
        lastFailure = messageOf(error);
        console.error(`Could not reconnect: ${lastFailure}`);
        return null;
      });
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
