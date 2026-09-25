// src/project-host-lease.ts — A BEARER'S LIVE CONNECTION ON A PROJECT HOST outlives no revocation.
// A project host admits a bearer once, when the request arrives (worker.ts), and hands the request
// to the project's app. A WebSocket or a streamed body can stay open long after that, so when the
// bearer carries a grant (an OAuth access token, a personal access token) the edge holds the
// connection itself and holds it to `holdGrantLease`, the lease `/api`'s socket holds too
// (rpc.ts): every 30 s the grant must still be live (oauth.ts `grantIsLive`: not ended, not
// expired, its email still allowed) and still reach the project, and a connection whose last
// successful check is 60 s old ends. A revoked key's connection therefore closes within a minute,
// at `/api` and on every project host. The connection asks because nothing can tell it: a
// revocation or a removed membership is a write to the control plane's D1, which notifies no one,
// and the connection lives in whichever edge isolate accepted it, which no writer can address.
//
// What is held, and how:
//   - a WebSocket: relayed through a pair the edge owns, so the edge can close both ends;
//   - a streamed body (no `content-length`: server-sent events, a long download): piped through the
//     edge, which aborts the pipe;
//   - a body of known length is answered as it is: it ends on its own.
// A cookie session's connection (a browser on an app's own host) is not held: a browser cannot put
// a bearer on a WebSocket, and a personal access token is never a cookie session.
import { reportIssue } from "iterate/lib";
import { ControlPlane, ControlPlaneUnavailableError, type Reach } from "./control-plane/edge.ts";
import type { Env } from "./env.ts";
import { grantIsLive, type AccessGrant } from "./oauth.ts";
import { isDeployReset, isRetryableTransportError } from "./retryable-error.ts";

/** How often a held connection's grant is read again, and how long the connection stays good
 *  without a read that succeeded. */
const RECHECK_MS = 30_000;
const LEASE_MS = 60_000;

/** WebSocket close code for a connection whose grant ended: 1008, policy violation (RFC 6455). */
const REVOKED_CLOSE_CODE = 1008;

/** `answer`, the project's app's response to a bearer admitted with `grant` and its `reach`, held
 *  to the grant's lease (above). */
export function leasedProjectHostAnswer(
  env: Env,
  grant: AccessGrant,
  reach: Reach,
  projectId: string,
  answer: Response,
): Response {
  const controlPlane = new ControlPlane(env);
  const hold = (end: (reason: string) => void) =>
    holdGrantLease(
      env,
      grant,
      () => controlPlane.reachesProject(reach, projectId),
      end,
      "project-host-lease",
    );
  if (answer.webSocket) return relayed(answer, answer.webSocket, hold);
  if (answer.body && !answer.headers.has("content-length")) return piped(answer, answer.body, hold);
  return answer;
}

/** THE LEASE on a connection a grant holds open (`/api`'s socket, rpc.ts; a project host's, above):
 *  `end` once, when a re-check finds the grant ended or `reaches` false, or no re-check has
 *  succeeded for `LEASE_MS`. The grant's own expiry bounds it too. `name` is the route that holds
 *  the connection, in the logs.
 *  Returns the lease's release, for a connection that closed on its own. */
export function holdGrantLease(
  env: Env,
  grant: AccessGrant,
  reaches: () => Promise<boolean>,
  end: (reason: string) => void,
  name: "live-authorization" | "project-host-lease",
): () => void {
  let released = false;
  let renewal: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    released = true;
    clearTimeout(renewal);
    clearTimeout(deadline);
  };
  const finish = (reason: string) => {
    if (released) return;
    release();
    end(reason);
  };
  const arm = (until: number) => {
    clearTimeout(deadline);
    deadline = setTimeout(
      () => finish("Session authorization expired"),
      Math.max(0, until - Date.now()),
    );
    renewal = setTimeout(renew, RECHECK_MS);
  };
  const renew = async () => {
    const started = Date.now();
    try {
      const [live, reached] = await Promise.all([grantIsLive(env, grant), reaches()]);
      if (released) return;
      if (!live || !reached) return finish("Session revoked or project access removed");
      arm(Math.min(started + LEASE_MS, grant.expiresAt));
    } catch (error) {
      if (released) return;
      // A RETRYABLE READ (a deploy resets the Durable Objects the tick reads, and workerd marks the
      // cut call retryable) or a control plane that is down (ControlPlaneUnavailableError) is asked
      // again within the lease's bound: the platform failed, not the grant. The event tells a
      // deploy's expected reset from a failure the prd fault alarm counts.
      if (isRetryableTransportError(error) || error instanceof ControlPlaneUnavailableError) {
        console.warn({
          event: isDeployReset(error)
            ? "oauth.deploy-reset-live-authorization-retry"
            : "oauth.platform-failure-live-authorization-retry",
          name,
          grantId: grant.grantId,
          message: String(error),
        });
        renewal = setTimeout(renew, 2_000);
        return;
      }
      reportIssue("oauth.live-authorization-failed", error, { grantId: grant.grantId, name });
      finish("Session authorization could not be renewed");
    }
  };
  arm(Math.min(Date.now() + LEASE_MS, grant.expiresAt));
  return release;
}

/** A WebSocket relayed through a pair the edge owns: every message passes through, a close on
 *  either end closes the other (a drop as 1011, `sendableCloseCode`), and the lease's end closes
 *  both with 1008. The app's handshake headers (a chosen subprotocol) are the client's. */
function relayed(
  answer: Response,
  upstream: WebSocket,
  hold: (end: (reason: string) => void) => () => void,
): Response {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  upstream.accept();
  server.accept();
  let closed = false;
  let release = () => {};
  const close = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    release();
    for (const socket of [server, upstream]) {
      try {
        socket.close(sendableCloseCode(code), reason.slice(0, 120));
      } catch {
        // already closed
      }
    }
  };
  const forward = (to: WebSocket) => (event: MessageEvent) => {
    try {
      to.send(event.data);
    } catch {
      close(1011, "Relay failed");
    }
  };
  server.addEventListener("message", forward(upstream));
  upstream.addEventListener("message", forward(server));
  server.addEventListener("close", (event) => close(event.code, event.reason));
  upstream.addEventListener("close", (event) => close(event.code, event.reason));
  server.addEventListener("error", () => close(1011, "Connection failed"));
  upstream.addEventListener("error", () => close(1011, "Connection failed"));
  release = hold((reason) => close(REVOKED_CLOSE_CODE, reason));
  return new Response(null, { status: 101, webSocket: client, headers: answer.headers });
}

/** A streamed body piped through the edge: the lease's end aborts the pipe, which cancels the
 *  app's body and errors the client's. */
function piped(
  answer: Response,
  body: ReadableStream,
  hold: (end: (reason: string) => void) => () => void,
): Response {
  const { readable, writable } = new TransformStream();
  const abort = new AbortController();
  const release = hold((reason) => abort.abort(new Error(reason)));
  body
    .pipeTo(writable, { signal: abort.signal })
    .catch(() => {
      // the client went away, the app's body failed, or the lease ended it: each ends the pipe
    })
    .finally(release);
  return new Response(readable, answer);
}

/** A close code a WebSocket may send in place of `code`. A close frame that carried no code (1005)
 *  was an orderly close: 1000. A connection that dropped without one (1006; 1015 for TLS) did not
 *  close normally, and a client told 1000 may take the end as meant and not reconnect: 1011, as for
 *  the reserved 1004 and anything out of range. */
function sendableCloseCode(code: number): number {
  if (code === 1005) return 1000;
  const sendable = code >= 1000 && code < 5000 && ![1004, 1006, 1015].includes(code);
  return sendable ? code : 1011;
}
