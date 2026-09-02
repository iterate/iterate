import type { ProjectAiInterceptor } from "iterate/node";
import { connectAdminItx } from "./forged-session.ts";

/**
 * Install an `intercepted/*` model handler that SURVIVES platform churn, on a
 * connection dedicated to the interception.
 *
 * The platform's contract (the mount invariant): while your session socket is
 * open your interceptor is live; if the platform's half dies (Durable Object
 * restart — common on cold preview deployments), your socket closes with
 * 4901; and the client owns one recovery loop — reconnect on close, install
 * again. This helper IS that loop, so specs don't each hand-roll
 * timeout-plus-journal-diagnosis recovery. A turn that loses its interceptor
 * mid-flight recovers on the agent's own retry (3 attempts, 10s/20s backoff)
 * once this loop re-installs — comfortably inside one attempt gap. The same
 * churn can also land BETWEEN connecting and installing, so the initial
 * install runs through the paced retry loop too, not just recoveries.
 *
 * Dedicated connection on purpose: the spec's main admin session dying must
 * not take the interception with it, and vice versa.
 */
export async function installResilientAiInterceptor(input: {
  baseUrl: string;
  /** Project id or slug, as `session.projects.get` accepts. */
  projectId: string;
  handler: ProjectAiInterceptor;
}): Promise<AsyncDisposable> {
  let disposed = false;
  // A close event triggers recovery only when it belongs to the CURRENT
  // session: each install bumps the generation before dialing, and a FAILED
  // install bumps it again before throwing, so a dead session's close (each
  // node ws fires close once) can never race the owning retry loop into a
  // second one.
  let generation = 0;
  let current: { session: Disposable; interception: { release(): Promise<void> } } | undefined;
  // At most one install loop at a time — initial and close-triggered recovery
  // share this guard, so a close landing mid-install (or mid-recovery) never
  // spawns a competing loop; the running loop's next attempt covers it.
  let installLoop: Promise<void> | undefined;

  const disposeSession = (session: Disposable) => {
    try {
      session[Symbol.dispose]();
    } catch {
      // Already dead — its interceptor died with it.
    }
  };

  const install = async () => {
    const myGeneration = ++generation;
    const previous = current;
    current = undefined;
    if (previous !== undefined) disposeSession(previous.session);
    let session: Awaited<ReturnType<typeof connectAdminItx>> | undefined;
    try {
      session = await connectAdminItx(input.baseUrl, {
        onWebSocketClose: (close) => {
          if (disposed || myGeneration !== generation) return;
          console.warn(
            `[resilient-ai-interceptor] session closed (${close.code} ${close.reason}); reconnecting`,
          );
          void runInstallLoop(Infinity);
        },
      });
      const interception = await session.projects.get(input.projectId).ai.intercept(input.handler);
      if (disposed) {
        // Disposal raced this install: never leave the handler mounted after
        // the spec tore down.
        await interception.release().catch(() => {});
        disposeSession(session);
        return;
      }
      current = { session, interception };
    } catch (error) {
      // This attempt's session is dead to us — whether the connect or the
      // install failed. Retire its generation BEFORE throwing so a late close
      // event from its socket cannot start a second, competing recovery loop.
      generation++;
      if (session !== undefined) disposeSession(session);
      throw error;
    }
  };

  const installWithRetry = async (maxAttempts: number) => {
    // Paced and capped; when endless (recovery), the spec's own assertions
    // time out if the deployment never comes back, so this only must not spin.
    for (let attempt = 1; !disposed; attempt++) {
      try {
        await install();
        if (attempt > 1) console.warn(`[resilient-ai-interceptor] installed (attempt ${attempt})`);
        return;
      } catch (error) {
        if (attempt >= maxAttempts) {
          // Terminal setup failure: the helper is dead, so no straggler close
          // event may resurrect an uncancelable recovery loop afterwards.
          disposed = true;
          throw error;
        }
        console.warn(`[resilient-ai-interceptor] install attempt ${attempt} failed: ${error}`);
        await new Promise((resolve) => setTimeout(resolve, Math.min(500 * attempt, 4_000)));
      }
    }
  };

  const runInstallLoop = (maxAttempts: number): Promise<void> => {
    installLoop ??= installWithRetry(maxAttempts).finally(() => {
      installLoop = undefined;
    });
    return installLoop;
  };

  // The initial install runs through the same loop (bounded: a genuinely
  // broken deployment should fail the spec's setup loudly, not hang it).
  await runInstallLoop(5);

  return {
    async [Symbol.asyncDispose]() {
      disposed = true;
      const active = current;
      current = undefined;
      if (active === undefined) return;
      await active.interception.release().catch(() => {});
      disposeSession(active.session);
    },
  };
}
