/**
 * The project-host session the browser holds for this app: the
 * `iterate-project-auth` cookie the platform gate mints for 15 minutes.
 * Nothing in the browser can read it (HttpOnly), but it can ask the gate to
 * renew it — the gate re-mints for the same user, project, and origin while
 * the current token still proves a member. This module owns that renewal:
 * the request, the schedule, and the hand-off to sign-in when the session
 * is dead. Everything takes its clock, timers, and fetch as inputs so the
 * rules are table-testable.
 */

import { z } from "zod";

const PROJECT_AUTH_LOGIN_PATH = "/_iterate/auth/login";
const PROJECT_AUTH_REFRESH_PATH = "/_iterate/auth/refresh";

const MINUTE_MS = 60_000;
/** Never wait longer than this: a sliding renewal must keep pace with revocation. */
const MAX_REFRESH_DELAY_MS = 10 * MINUTE_MS;
/** A lapsed session renews at once (well, after a beat). */
const MIN_REFRESH_DELAY_MS = 1_000;
/** A renewal round trip that takes longer than this is an outage, not a wait. */
const REFRESH_TIMEOUT_MS = 15_000;
/**
 * How many times ONE renewal tries the gate before falling back to the
 * keepalive's slower cadence. The project host's POST path fronts the config
 * worker's proxy to the vessel, which returns an intermittent 500 on POST
 * (GET is unaffected); a member is still signed in, so a couple of fast
 * retries turn that flake into a renewal instead of a minute-long gap. A 401
 * (dead session) never retries — it is an answer, not a flake.
 */
const REFRESH_ATTEMPTS = 4;
/** Backoff between those attempts: quick, since the flake clears on its own. */
const refreshBackoffMs = (attempt: number) => Math.min(1_000, 200 * 2 ** (attempt - 1));
/** A renewal younger than this is fresh enough to skip on a tab flap. */
const FRESH_ENOUGH_MS = MINUTE_MS;

export type RefreshOutcome =
  | { outcome: "renewed"; expiresAt: number }
  | { outcome: "signed-out"; login: string }
  | { outcome: "unavailable" };

/** The gate's 200 body: the renewed token's expiry, in seconds. */
const RenewedBody = z.object({ expiresAt: z.number() }).loose();
/** The gate's 401 body: where to sign in again (an absolute path on this origin). */
const SignedOutBody = z.object({ login: z.string().startsWith("/") }).loose();

/** The response body as JSON, or null when there is none worth reading. */
async function jsonOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** The gate's login start for one page (the same link its sign-in page carries). */
export function loginPathFor(returnTo: string): string {
  return `${PROJECT_AUTH_LOGIN_PATH}?${new URLSearchParams({ return_to: returnTo })}`;
}

/**
 * One renewal round trip. A 401 is a dead session (the gate's body carries
 * the login pointer); anything else that is not a renewal is an outage the
 * caller should retry later.
 */
export async function refreshProjectSession(input: {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  returnTo: string;
  /** Retry policy for transient failures — injected so the rule is testable. */
  retry?: {
    attempts: number;
    delayMs: (attempt: number) => number;
    sleep: (ms: number) => Promise<void>;
  };
}): Promise<RefreshOutcome> {
  const url = `${PROJECT_AUTH_REFRESH_PATH}?${new URLSearchParams({ return_to: input.returnTo })}`;
  const retry = input.retry ?? {
    attempts: REFRESH_ATTEMPTS,
    delayMs: refreshBackoffMs,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  let last: RefreshOutcome = { outcome: "unavailable" };
  for (let attempt = 1; attempt <= retry.attempts; attempt++) {
    last = await attemptRefresh(input.fetch, url, input.returnTo);
    // Only a transient outage is worth another try; a renewal or a dead
    // session is a final answer.
    if (last.outcome !== "unavailable") return last;
    if (attempt < retry.attempts) await retry.sleep(retry.delayMs(attempt));
  }
  return last;
}

/** One renewal round trip. See {@link refreshProjectSession} for the retry loop. */
async function attemptRefresh(
  fetch: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  returnTo: string,
): Promise<RefreshOutcome> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "same-origin", method: "POST" });
  } catch {
    return { outcome: "unavailable" };
  }
  if (response.status === 401) {
    // A bare 401 still means signed out; the login pointer is a courtesy.
    const body = SignedOutBody.safeParse(await jsonOf(response));
    return {
      outcome: "signed-out",
      login: body.success ? body.data.login : loginPathFor(returnTo),
    };
  }
  if (!response.ok) return { outcome: "unavailable" };
  const body = RenewedBody.safeParse(await jsonOf(response));
  return body.success
    ? { outcome: "renewed", expiresAt: body.data.expiresAt }
    : { outcome: "unavailable" };
}

/**
 * Half the remaining lifetime, capped: soon enough to never lapse, rare enough
 * to stay cheap. Halving is self-limiting (each renewal resets the clock), so
 * a short remainder gets a short delay rather than a floor that would wait
 * past expiry.
 */
export function nextRefreshDelayMs(expiresAt: number, now: number): number {
  const remaining = expiresAt * 1000 - now;
  return Math.min(MAX_REFRESH_DELAY_MS, Math.max(MIN_REFRESH_DELAY_MS, remaining / 2));
}

/**
 * Keep the session alive while the page is open: renew on start, then at
 * half the remaining lifetime; retry an outage in a minute; renew at once
 * when a tab comes back to the foreground with a stale renewal; hand a dead
 * session to sign-in exactly once and stop. Returns the stop function.
 */
export function startProjectSessionKeepalive<TimerId>(input: {
  refresh: () => Promise<RefreshOutcome>;
  now: () => number;
  timers: { set: (fn: () => void, ms: number) => TimerId; clear: (id: TimerId) => void };
  onSignedOut: (login: string) => void;
  visibility?: { isVisible: () => boolean; onVisible: (fn: () => void) => () => void };
}): () => void {
  let timer: TimerId | null = null;
  let stopped = false;
  let inFlight = false;
  let lastRenewedAt = Number.NEGATIVE_INFINITY;

  const arm = (ms: number) => {
    if (timer !== null) input.timers.clear(timer);
    timer = input.timers.set(() => {
      timer = null;
      void tick();
    }, ms);
  };

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    let result: RefreshOutcome;
    try {
      result = await input.refresh();
    } finally {
      inFlight = false;
    }
    if (stopped) return;
    if (result.outcome === "renewed") {
      lastRenewedAt = input.now();
      arm(nextRefreshDelayMs(result.expiresAt, input.now()));
    } else if (result.outcome === "unavailable") {
      arm(MINUTE_MS);
    } else {
      stop();
      input.onSignedOut(result.login);
    }
  };

  const unsubscribe = input.visibility?.onVisible(() => {
    if (!stopped && input.now() - lastRenewedAt > FRESH_ENOUGH_MS) void tick();
  });

  const stop = () => {
    stopped = true;
    if (timer !== null) input.timers.clear(timer);
    timer = null;
    unsubscribe?.();
  };

  void tick();
  return stop;
}

/** The browser wiring of the keepalive: real fetch, clock, timers, and navigation. */
export function startBrowserProjectSessionKeepalive(): () => void {
  return startProjectSessionKeepalive({
    refresh: () =>
      refreshProjectSession({
        fetch: (url, init) =>
          fetch(url, { ...init, signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) }),
        returnTo: `${location.pathname}${location.search}`,
      }),
    now: () => Date.now(),
    timers: {
      set: (fn, ms) => window.setTimeout(fn, ms),
      clear: (id) => window.clearTimeout(id),
    },
    onSignedOut: (login) => location.assign(login),
    visibility: {
      isVisible: () => document.visibilityState === "visible",
      onVisible: (fn) => {
        const handler = () => {
          if (document.visibilityState === "visible") fn();
        };
        document.addEventListener("visibilitychange", handler);
        return () => document.removeEventListener("visibilitychange", handler);
      },
    },
  });
}
