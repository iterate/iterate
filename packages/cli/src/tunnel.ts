import { randomBytes } from "node:crypto";
import { RpcTarget, upgradeWebSocketResponse, WebSocketPair } from "capnweb";
import WebSocket from "ws";
import type { connectIterate } from "iterate/node";

/** Headers that describe one hop, never the request: the local dial makes its own. */
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

/** A routing slug (`blog` for `blog--<project>`): a DNS label's start, never the `--` separator,
 *  short enough that `tunnel-<slug>` is a DNS label too. */
const ROUTING_SLUG = /^[a-z](?:[a-z0-9]|-(?!-))*$/;
const ROUTING_SLUG_MAX_LENGTH = 50;
/** What a deployment needs so each project app, a tunnel included, gets its own origin. */
const CUSTOM_DOMAIN_DOCS =
  "https://github.com/iterate/iterate/blob/main/apps/os/SELF-HOSTING.md#custom-domain-own-origins-for-apps-and-tunnels";
/** Routing slugs the edge answers itself, never the config worker (apps/os
 *  src/context/file-urls.ts `FILES_ROUTING_SLUG`: signed file URLs). */
const RESERVED_ROUTING_SLUGS = ["files"];

/** THE TUNNEL'S LENT STUB: every request the project's host routes here, proxied to
 *  `http://localhost:<port>` — path and query, method, headers (plus `x-forwarded-host` and
 *  `x-forwarded-proto`: the host the visitor used; under paths routing the base path the edge
 *  stripped put back), the body streamed, redirects handed back as they
 *  are. A WebSocket upgrade dials `ws://localhost:<port>` with the subprotocols the visitor asked
 *  for and pumps frames both ways; the 101 names the one the local server chose. Nothing listening
 *  is a 502 naming the port. */
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
    // Under paths routing the edge strips `/projects/<project>/<slug>` and says it here; the local
    // server serves under that base (Vite: `--base`), so the path it sees is the one the visitor
    // asked for.
    const basePath = request.headers.get("x-iterate-base-path") || "";
    // Set piecewise, never joined as a string: a path of `//other-host/` must stay a path on
    // localhost, never become a destination.
    const localUrl = new URL(this.#localOrigin());
    localUrl.pathname = `${basePath}${visitorUrl.pathname}`;
    localUrl.search = visitorUrl.search;
    const headers = new Headers(request.headers);
    for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
    headers.set("x-forwarded-host", visitorUrl.host);
    headers.set("x-forwarded-proto", visitorUrl.protocol.slice(0, -1));
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
    // fetch decoded a compressed body: its encoding and length describe bytes no longer there
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
      try {
        visitorSide.send(isBinary ? new Uint8Array(toBuffer(data)) : toBuffer(data).toString());
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

  #localOrigin(): string {
    return `http://localhost:${this.#port}`;
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

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** undici hides the reason a dial failed (ECONNREFUSED) in `cause`. */
function causeOf(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  return cause?.code || cause?.message || (error instanceof Error ? error.message : String(error));
}

/** A short random routing slug: a letter, then seven letters or digits. */
export function randomRoutingSlug(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(8);
  return [...bytes]
    .map((byte, index) => alphabet[byte % (index === 0 ? 26 : alphabet.length)])
    .join("");
}

/** `iterate tunnel <port>`: lend a `LocalPortRpcTarget` to the project as `itx.tunnels.<slug>`, set
 *  the fetch route `tunnel-<slug>` taking the `<slug>` host to it, print the URL, and on Ctrl-C
 *  delete the route, then end the lend. A disconnect ends the tunnel with an error. */
export async function runTunnel(input: {
  connection: Awaited<ReturnType<typeof connectIterate>>;
  project: string;
  port: number;
  routingSlug?: string;
  public?: boolean;
  json?: boolean;
}): Promise<void> {
  const routingSlug = input.routingSlug || randomRoutingSlug();
  if (RESERVED_ROUTING_SLUGS.includes(routingSlug))
    throw new Error(
      `--name ${routingSlug} is reserved: the platform serves the ${routingSlug}--<project> host itself`,
    );
  if (!ROUTING_SLUG.test(routingSlug) || routingSlug.length > ROUTING_SLUG_MAX_LENGTH)
    throw new Error(
      `--name ${JSON.stringify(routingSlug)} is not a routing slug: lowercase letters, digits and single hyphens, starting with a letter, at most ${ROUTING_SLUG_MAX_LENGTH} characters`,
    );
  type TunnelEvent =
    | { type: "live"; url: string; routingSlug: string; fetchRouteName: string; public: boolean }
    | { type: "request"; line: string }
    | { type: "stopped" };
  const emit = (event: TunnelEvent) => {
    if (input.json) process.stdout.write(`${JSON.stringify(event)}\n`);
  };
  const fetchRouteName = `tunnel-${routingSlug}`;
  const target = `itx.tunnels.${routingSlug}`;
  using project = await input.connection.session.projects.get(input.project);
  const url = await project.url({ routingSlug });
  const basePath = new URL(url).pathname;
  // A host another route already takes is someone else's: refuse, never take it over. A tunnel of
  // the same name (a restart, another terminal) is taken over.
  const taken = (await project.fetchRoutes.list()).find(
    (route) =>
      route.fetchRouteName !== fetchRouteName && route.requestMatcher.routingSlug === routingSlug,
  );
  if (taken)
    throw new Error(
      `The ${routingSlug} host already has the fetch route ${JSON.stringify(taken.fetchRouteName)}, which this tunnel would shadow or be shadowed by. Pick another --name.`,
    );
  const standing = (await project.fetchRoutes.list()).find(
    (route) => route.fetchRouteName === fetchRouteName,
  );
  if (standing && standing.target.join(".") !== target)
    throw new Error(
      `The fetch route ${fetchRouteName} exists and was not made by a tunnel (its target is ${standing.target.join(".")}). Pick another --name.`,
    );
  const log = (line: string) => {
    if (input.json) emit({ type: "request", line });
    else console.error(line);
  };
  using _provision = await project.provide(target, new LocalPortRpcTarget(input.port, log));
  await project.fetchRoutes.set(fetchRouteName, {
    requestMatcher: { routingSlug },
    target,
    authRequirement: input.public ? null : { visitors: "project-members" },
  });
  try {
    // Listening before the URL is out: until a listener is installed the OS's default action ends
    // the process at once, so a Ctrl-C right after `live` would leave the route standing.
    let stop: () => void = () => {};
    const stopped = new Promise<"stopped">((resolve) => {
      stop = () => resolve("stopped");
    });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    emit({ type: "live", url, routingSlug, fetchRouteName, public: Boolean(input.public) });
    console.error(
      `${url} → http://localhost:${input.port} (${input.public ? "public" : "project members only"}). Press Ctrl-C to stop.`,
    );
    if (basePath !== "/")
      console.error(
        `This deployment serves projects under paths, so this tunnel lives at ${url}. Your local server must serve under ${basePath} (Vite: --base ${basePath}); a server that only works at / will not work here. To serve at the root of its own origin, give the deployment a domain with a wildcard certificate: ${CUSTOM_DOMAIN_DOCS}`,
      );
    try {
      const outcome = await Promise.race([stopped, input.connection.closed]);
      if (outcome !== "stopped")
        throw new Error(
          `The tunnel disconnected (${outcome.code}: ${outcome.reason || "connection closed"}). Run iterate tunnel again to reconnect.`,
        );
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } finally {
    // the route first: the host stops answering 502 the moment it is gone
    await project.fetchRoutes.set(fetchRouteName, null).catch((error: unknown) => {
      console.error(
        `Could not delete the fetch route ${fetchRouteName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    emit({ type: "stopped" });
  }
}
