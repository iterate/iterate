// e2e/support/isolate-ceilings.ts — what the two ceilings files share: the MiB, a payload of one letter, the
// reset detector and a settle-to-outcome helper. They live apart so the suite's longest row runs
// beside the rest instead of after it.

export const MiB = 1024 * 1024;

/** A blob of `chars` code units — the payload that fills a body toward the 8 MiB append ceiling. */
export const blob = (chars: number): string => "q".repeat(chars);

/** The signal of an UNCONTROLLED reset: `.durableObjectReset` where a hop kept workerd's stamp, or
 *  the reset's own message, which the edge keeps when it answers the failure UNAVAILABLE
 *  (apps/os/src/unavailable.ts): "…isolate exceeded its memory limit and was reset.", "…caused
 *  object to be reset…". NOT a loaded-isolate OOM ("Worker exceeded memory limit.") and NOT a facet
 *  wedge (SQLITE_TOOBIG). */
export const isDurableObjectReset = (e: any): boolean =>
  e != null &&
  (e.durableObjectReset === true ||
    /\b(was|to be) reset\b|Durable Object reset\b/i.test(String(e.message ?? e)));

/** Settle a promise to a tagged outcome so a reset never escapes as an unhandled rejection (the e2e
 *  config only forgives WebSocket/RPC-session noise; a `durableObjectReset` message would be fatal). */
export const settle = <T>(p: Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: any }> =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e }),
  );
