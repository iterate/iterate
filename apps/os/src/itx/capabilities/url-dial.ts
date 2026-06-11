// UrlDial: the dial path for `{ type: "url" }` capability targets — a remote
// Cap'n Web server addressed by URL (itx-next.md §1).
//
// Law 7 lives here: the Cap'n Web session terminates in THIS stateless
// worker, never a Durable Object. The context node (a DO) hands the call across
// as data; this entrypoint opens a WebSocket session, replays the call
// against the remote main, and closes the session before returning. One
// session per call — remote caps are stateless from the platform's point of
// view, exactly like loopback and source refs.
//
// Always a WebSocket session, never an HTTP batch (`newHttpBatchRpcSession`
// is banned repo-wide by the iterate/no-capnweb-http-batch lint rule):
// stateless workers can hold a socket for the duration of a request, and a
// real session keeps promise pipelining intact.
//
// Headers ride the WebSocket handshake and pass through the SAME
// getSecret() placeholder substitution as project egress (Law 5), resolved
// via the SecretsCapability loopback — so a provider writes
// `authorization: 'Bearer getSecret({ key: "REMOTE_TOKEN" })'` and the
// secret material never appears in any journal record or describe() output.
// Known gap: these dials bypass fetch-cap shadowing (the UrlDial → Project
// DO hop is Workers jsrpc, which cannot carry a WebSocket-bearing Response).

import { WorkerEntrypoint } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { RESERVED_PATH_SEGMENTS, type PathCall } from "../itx.ts";
import { substituteProjectEgressSecretHeaders } from "~/domains/projects/egress-secret-substitution.ts";
import { getSecretsCapability } from "~/domains/secrets/entrypoints/secrets-capability.ts";

/**
 * How a FORWARDER treats the inner object it fronts (here, the remote main):
 * replay the path on its members (default) or hand it one call({path, args}).
 * Forwarder props, not kernel data — the core knows ONE calling convention.
 */
export type WorkerInvokeMode = "members" | "path-call";

export type UrlDialProps = {
  /** The remote Cap'n Web server. Provider-supplied; http(s) or ws(s). */
  url: string;
  /** Handshake headers; values pass through egress secret substitution. */
  headers?: Record<string, string>;
  /** How to treat the REMOTE main: members pipelining (default) or one
   * call({ path, args }). Forwarder props, not kernel data — `{ type:
   * "url" }` cap targets always get the default; an SDK-shaped remote is
   * reachable by providing UrlDial as a loopback cap with props.invoke. */
  invoke?: WorkerInvokeMode;
  /** Attribution + secret scope, injected by the dial. */
  capabilityPath?: string;
  context?: string;
  projectId?: string;
};

export class UrlDial extends WorkerEntrypoint<Env, UrlDialProps> {
  async call(input: PathCall): Promise<unknown> {
    const props = this.ctx.props;
    if (!props.url) throw new Error("UrlDial needs props.url (the remote Cap'n Web server).");
    if (!props.projectId) {
      // The dial always injects projectId; refusing without it means a
      // hand-built dial can never resolve another project's secrets.
      throw new Error("UrlDial needs dial-injected projectId props.");
    }
    const url = dialableHttpUrl(props.url);

    const headers = new Headers(props.headers ?? {});
    const [substitutionError, substitutedHeaders] = await substituteProjectEgressSecretHeaders({
      headers,
      secrets: getSecretsCapability({
        exports: this.ctx.exports as unknown as Pick<Cloudflare.Exports, "SecretsCapability">,
        props: { projectId: props.projectId },
      }),
    });
    if (substitutionError) {
      throw new Error(
        `URL dial header substitution failed: ${await substitutionError.text().catch(() => substitutionError.statusText)}`,
      );
    }
    for (const [header, value] of Object.entries(substitutedHeaders)) {
      headers.set(header, value);
    }
    headers.set("Upgrade", "websocket");

    const response = await fetch(url, { headers });
    const socket = response.webSocket;
    if (!socket) {
      throw new Error(
        `URL dial to ${url.origin} did not upgrade to a WebSocket (status ${response.status}).`,
      );
    }
    socket.accept();

    const remote = newWebSocketRpcSession(socket as unknown as WebSocket);
    try {
      if (props.invoke === "path-call") {
        // One round trip: the remote main implements call({ path, args }).
        return await (remote as unknown as { call(input: PathCall): unknown }).call(input);
      }
      // Default: walk the path as capnweb property pipelining (still one
      // round trip — the path resolves remotely) and call the terminal stub.
      // Same reserved-segment filter as replayPathCall: these names are stub
      // controls / pollution vectors LOCALLY, before anything reaches the wire.
      let cursor: unknown = remote;
      for (const segment of input.path) {
        if (RESERVED_PATH_SEGMENTS.has(segment)) {
          throw new Error(`Path segment ${JSON.stringify(segment)} is reserved.`);
        }
        cursor = (cursor as Record<string, unknown>)[segment];
      }
      return await (cursor as (...args: unknown[]) => unknown)(...input.args);
    } finally {
      (remote as unknown as Partial<Disposable>)[Symbol.dispose]?.();
      try {
        socket.close(1000, "itx url dial complete");
      } catch {
        // Already closed by session disposal.
      }
    }
  }
}

/**
 * Workers dial WebSockets with an Upgrade fetch, which only accepts http(s)
 * URLs — ws(s) spellings normalize here so providers can use either.
 */
function dialableHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`URL dial target must be http(s) or ws(s), got ${JSON.stringify(raw)}.`);
  }
  return url;
}
