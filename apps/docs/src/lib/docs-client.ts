import { newWebSocketRpcSession } from "capnweb";
import type { DocsApi } from "./docs-api.ts";
import { refreshProjectSession, type RefreshOutcome } from "./project-session.ts";

/**
 * The app's ONE live Cap'n Web session to its vessel, shared by every caller
 * (document page, comments, the file tree's poll, the board). A session dies
 * with its socket — a laptop sleep, a colo hiccup, the gate refusing a
 * handshake once the project cookie lapsed — and every call in flight on it
 * fails. Recovery is the client's job and has three rules:
 *
 * 1. Only a TRANSPORT failure replaces the session. An application error
 *    ("document does not exist", "not the owner") is an answer, and tearing
 *    the shared socket down for it would fail every other caller.
 * 2. One failure wave, one re-dial: callers that lost the same session all
 *    ride the replacement instead of each minting their own.
 * 3. When the replacement itself cannot connect, the likeliest cause is a
 *    lapsed project session: renew it through the gate and try once more; a
 *    session the gate declares dead hands off to sign-in. One renewal is
 *    shared by everyone waiting on it, and no session dialed before it
 *    completed is trusted afterwards — its handshake carried the old cookie.
 */

function dialDocsApi() {
  const url = new URL("/api", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const session = newWebSocketRpcSession<DocsApi>(url.toString());
  return { project: session.authenticate(), session };
}

/**
 * Whether an error means the session's transport is gone, not that the call
 * was refused. "missing or invalid auth" belongs here too: it is OS refusing
 * the vessel's re-dial with the token this browser session was born with,
 * so only a fresh browser handshake (which carries the renewed cookie) can
 * bring the session back.
 */
export function isSessionTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /shut down|network connection lost|connection closed|websocket|did not upgrade|socket hang up|failed to fetch|missing or invalid auth/i.test(
    message,
  );
}

export function createDocsClient<Project>(deps: {
  dial: () => { project: Project; session: unknown };
  refresh: () => Promise<RefreshOutcome>;
  signInAgain: (login: string) => void;
  isTransportError?: (error: unknown) => boolean;
}) {
  const isTransport = deps.isTransportError ?? isSessionTransportError;
  let live: { project: Project; session: unknown; generation: number } | null = null;
  let generation = 0;
  let renewing: Promise<RefreshOutcome> | null = null;
  /** The generation counter when the last renewal completed: every session
   * dialed at or before it shook hands with the cookie that renewal replaced. */
  let renewedAtGeneration = 0;

  const renew = () => {
    renewing ??= deps
      .refresh()
      .then((outcome) => {
        renewedAtGeneration = generation;
        return outcome;
      })
      .finally(() => {
        renewing = null;
      });
    return renewing;
  };

  const current = () => (live ??= { ...deps.dial(), generation: ++generation });

  /** Replace the session a caller lost — unless someone already did. */
  const replace = (lost: number) => {
    if (live !== null && live.generation > lost) return live;
    dispose(live?.session);
    live = { ...deps.dial(), generation: ++generation };
    return live;
  };

  async function withDocsProject<T>(operation: (project: Project) => PromiseLike<T>): Promise<T> {
    const first = current();
    try {
      return await operation(first.project);
    } catch (firstError) {
      if (!isTransport(firstError)) throw firstError;
      const second = replace(first.generation);
      try {
        return await operation(second.project);
      } catch (secondError) {
        if (!isTransport(secondError)) throw secondError;
        const renewal = await renew();
        if (renewal.outcome === "signed-out") {
          deps.signInAgain(renewal.login);
          throw new Error("Your session expired — signing in again…");
        }
        const third = replace(Math.max(second.generation, renewedAtGeneration));
        return await operation(third.project);
      }
    }
  }

  /** The live session, no recovery: for callers that must never tear it down. */
  async function withDocsProjectOnce<T>(
    operation: (project: Project) => PromiseLike<T>,
  ): Promise<T> {
    return await operation(current().project);
  }

  return { withDocsProject, withDocsProjectOnce };
}

function dispose(session: unknown): void {
  try {
    // Cap'n Web sessions are explicit-resource-management objects. The
    // runtime check keeps this safe in browsers without Symbol.dispose.
    (session as { [Symbol.dispose]?: () => void } | undefined)?.[Symbol.dispose]?.();
  } catch {
    // A broken WebSocket session may already have disposed itself.
  }
}

const browserClient = createDocsClient<ReturnType<typeof dialDocsApi>["project"]>({
  dial: dialDocsApi,
  refresh: () =>
    refreshProjectSession({
      fetch: (url, init) => fetch(url, init),
      returnTo: `${location.pathname}${location.search}`,
    }),
  signInAgain: (login) => location.assign(login),
});

export const withDocsProject = browserClient.withDocsProject;
export const withDocsProjectOnce = browserClient.withDocsProjectOnce;
