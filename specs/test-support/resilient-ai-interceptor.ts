import { connectAdminItx } from "./forged-session.ts";

/**
 * Install an `intercepted/*` model handler that SURVIVES platform churn, on a
 * connection dedicated to the interception.
 *
 * The platform's contract (the mount invariant, extended to interceptors):
 * while your session socket is open your interceptor is live; if the
 * platform's half dies (Project Durable Object restart — common on cold
 * preview deployments), your socket closes with 4901; and the client owns one
 * recovery loop — reconnect on close, install again. This helper IS that
 * loop, so specs don't each hand-roll timeout-plus-journal-diagnosis
 * recovery. A turn that loses its interceptor mid-flight recovers on the
 * agent's own retry (3 attempts, 10s/20s backoff) once this loop re-installs
 * — comfortably inside one attempt gap.
 *
 * Dedicated connection on purpose: the spec's main admin session dying must
 * not take the interception with it, and vice versa.
 */
export async function installResilientAiInterceptor(input: {
  baseUrl: string;
  /** Project id or slug, as `session.projects.get` accepts. */
  projectId: string;
  handler: (call: {
    source: "agent-turn" | "ai-run";
    model: string;
    body: { messages: { role: string; content: string }[] };
  }) => Promise<unknown>;
}): Promise<AsyncDisposable> {
  let disposed = false;
  // A close event triggers recovery only when it belongs to the CURRENT
  // session: each install bumps the generation before dialing, so a stale
  // session's close (each node ws fires close once) can never race a fresh
  // install into a second loop.
  let generation = 0;
  let current: { session: Disposable; interception: { release(): Promise<void> } } | undefined;

  const install = async () => {
    const myGeneration = ++generation;
    const previous = current;
    current = undefined;
    if (previous !== undefined) {
      try {
        previous.session[Symbol.dispose]();
      } catch {
        // Already dead — its interceptor died with it.
      }
    }
    const session = await connectAdminItx(input.baseUrl, {
      onWebSocketClose: (close) => {
        if (disposed || myGeneration !== generation) return;
        console.warn(
          `[resilient-ai-interceptor] session closed (${close.code} ${close.reason}); reconnecting`,
        );
        void reconnect();
      },
    });
    const interception = await session.projects.get(input.projectId).ai.intercept(input.handler);
    current = { session, interception };
  };

  const reconnect = async () => {
    // Paced, capped, and endless while the spec lives: the spec's own
    // assertions time out if the deployment never comes back, so this loop
    // only needs to not spin.
    for (let attempt = 1; !disposed; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(500 * attempt, 4_000)));
      if (disposed) return;
      try {
        await install();
        console.warn(`[resilient-ai-interceptor] re-installed (attempt ${attempt})`);
        return;
      } catch (error) {
        console.warn(`[resilient-ai-interceptor] reconnect attempt ${attempt} failed: ${error}`);
      }
    }
  };

  await install();

  return {
    async [Symbol.asyncDispose]() {
      disposed = true;
      const active = current;
      current = undefined;
      if (active === undefined) return;
      await active.interception.release().catch(() => {});
      try {
        active.session[Symbol.dispose]();
      } catch {
        // Session already dead — its interceptor died with it.
      }
    },
  };
}
