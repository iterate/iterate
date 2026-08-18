/**
 * The one seam between an itx session's TRANSPORT (the /api WebSocket a
 * client holds) and the RPC target tree running inside it.
 *
 * It exists for exactly one signal: when the platform's half of a live
 * capability mount dies (the scope's Capability Provider Pager closes from
 * the far side), the session must die WITH it, so the client's reconnect
 * loop re-dials and re-runs its idempotent `projects.connect`. That is the
 * mount invariant: a client holding an open socket is provably mounted; a
 * client whose mount is gone gets a close event instead of silence.
 *
 * Keyed on the request's ExecutionContext because that object already flows
 * through every RpcTarget in the session as `props.ctx` — threading a close
 * callback through a dozen constructor signatures for one signal would tax
 * every caller, including the Durable-Object-side ones that have no client
 * transport at all. Registration happens only where the WebSocket pair is
 * created (worker.ts); everywhere else this map simply has no entry and
 * {@link closeItxSessionTransport} is a no-op.
 */
const transportClosers = new WeakMap<object, (code: number, reason: string) => void>();

/** Worker-side registration at WebSocket upgrade time; one per session. */
export function registerItxSessionTransport(
  ctx: object,
  close: (code: number, reason: string) => void,
): void {
  transportClosers.set(ctx, close);
}

/**
 * Close the session's client transport, if this execution context has one.
 * Returns whether a transport was registered (HTTP batch calls and
 * Durable-Object-side itx have none, and that is fine).
 */
export function closeItxSessionTransport(ctx: object, code: number, reason: string): boolean {
  const close = transportClosers.get(ctx);
  if (close === undefined) return false;
  try {
    close(code, reason);
  } catch {
    // Already closed — the invariant holds either way.
  }
  return true;
}
