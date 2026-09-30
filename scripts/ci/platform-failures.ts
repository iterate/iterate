// scripts/ci/platform-failures.ts — THE PLATFORM'S FAILURES AS A TEST ROW MEETS THEM: what a row
// run against a deployment can fail on only because Cloudflare, or the network between the runner
// and it, failed it, never on anything our code decides. Read off the row's failure message alone.
// The latency guard (scripts/monitors/latency.ts) and the flake dashboard's unknown flakes
// (./flake-dashboard/dashboard.ts) judge a row by this table, and each lets the platform break the
// same row once: broken again in its next run, the row's failure is its own. A crash of our own
// Worker reads the same from the client, and that rule is what catches it.

/** Each failure, by the words a report prints for it. */
export const PLATFORM_FAILURES = {
  /** undici's fetch rejects with exactly this only when no HTTP response came at all: the
   *  connection to the edge reset before an answer (`read ECONNRESET` in its cause). */
  "connection-reset": "a fetch got no HTTP response: the connection to the edge failed",
  /** capnweb's word for a session socket that ended with no Close frame. Our Worker ends every
   *  socket it closes with a code and a reason ("Peer closed WebSocket: 3000 …"), and the edge's own
   *  invocation for such a socket ends `ok`, having seen the client go: the connection was cut
   *  between the runner and the Worker. A Worker's WebSocket lasts only as long as the isolate and
   *  the server holding it (https://developers.cloudflare.com/workers/best-practices/workers-best-practices/#use-durable-objects-for-websockets,
   *  https://developers.cloudflare.com/network/websockets/#technical-note). */
  "socket-lost": "a WebSocket ended with no Close frame: the edge dropped it",
  /** workerd's DISCONNECTED failure, handed back through a session that stayed open: a Workers RPC
   *  connection under the call, from our Worker to a Durable Object or between two objects, was cut
   *  inside Cloudflare. Our code never throws it, and a reset of our own objects fails with a
   *  message of its own (packages/iterate/src/platform-retry.ts `failureKind`). The edge sends an
   *  idempotent call it cut once more (apps/os/src/context-stub.ts `IDEMPOTENT_CALLS`), so what
   *  reaches a row is a write, or a second cut. */
  "transport-cut": "a Workers RPC connection under the call was lost inside Cloudflare",
  /** Cloudflare's words for a call in flight on a Durable Object instance it shut down, to host the
   *  object elsewhere or to update its runtime, once the call touched storage
   *  (https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/#shutdown-behavior).
   *  workerd stamps it `retryable`, so the edge sends an idempotent call it failed once more on the
   *  new instance, as it does a transport cut; our code never throws it. */
  "object-shut-down": "a Durable Object instance Cloudflare shut down failed the call",
} as const;
export type PlatformFailure = keyof typeof PLATFORM_FAILURES;

/** Each failure's message, as `Error.prototype.message` spells it. */
const MESSAGES: readonly (readonly [PlatformFailure, string])[] = [
  ["connection-reset", "fetch failed"],
  ["socket-lost", "WebSocket connection failed."],
  ["transport-cut", "Network connection lost."],
  [
    "object-shut-down",
    "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.",
  ],
];

/** Which platform failure a row failed on, from its failure message: the error's first line, which
 *  is the failure's words alone (a flake record keeps the message) or ends with them after a colon.
 *  That colon is the `Error: ` or `TypeError: ` a JSON report's stack starts with, a hop that names
 *  the call it failed ("The control plane failed accessibleTo: …"), or a poll that ran out of time
 *  on it ("until(…): timed out … — last error: …"). Undefined for any other failure. Pure. */
export function platformFailureOf(message: string): PlatformFailure | undefined {
  const firstLine = message.split("\n", 1)[0]!.trim();
  return MESSAGES.find(([, words]) => firstLine === words || firstLine.endsWith(`: ${words}`))?.[0];
}
