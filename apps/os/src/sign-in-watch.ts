// src/sign-in-watch.ts — WHERE A SLOW SIGN-IN WAITS. A sign-in is a chain of I/O steps (the password
// counters in KV, the control plane's user row, the browser session's Durable Object, the provider's
// grant, the code exchange over the issuer's own public URL), and a step that stalls spends almost
// no CPU: Workers Logs then show a `/login` that ran 15 s on 3 ms of CPU and was cancelled by its
// client, with nothing naming the step. Each step is watched: one that has not settled after
// SLOW_STEP_MS logs its line WHILE it still waits — a line that lands even when the client gives up
// first and the invocation is cancelled.
//
// The code exchange is itself a chain, inside the token endpoint: the grant store, the person's
// account (oauth.ts `accountStateOf`) and the provider's KV. Its hops are watched the same way, as
// `oauth.step-slow`, because every refresh and every admission runs them too.

/** Well above a healthy step (a whole sign-in answers in about a second), well below the 10 s the
 *  code exchange is bounded by and the 15 s a spec's sign-in waits. */
const SLOW_STEP_MS = 5_000;

/** `work`, with `line` and how long it has waited logged if it is still pending after SLOW_STEP_MS. */
export async function watchSlowStep<Work extends PromiseLike<unknown>>(
  line: { event: string; step: string } & Record<string, unknown>,
  work: Work,
): Promise<Awaited<Work>> {
  const started = Date.now();
  const watchdog = setTimeout(
    () => console.warn({ ...line, waitedMs: Date.now() - started }),
    SLOW_STEP_MS,
  );
  try {
    return await work;
  } finally {
    clearTimeout(watchdog);
  }
}

/** A sign-in's own step, watched: `issuer.sign-in-slow` names it. */
export function watchSignInStep<Work extends PromiseLike<unknown>>(step: string, work: Work) {
  return watchSlowStep({ event: "issuer.sign-in-slow", step }, work);
}
