// Factual log of what the user did in the app this session: screen
// navigations, errors, failed queries, plus hand-instrumented domain events
// via logEvent(). Read-only telemetry — nothing here drives the app.
//
// The in-memory ring buffer is the source of truth: it works on any server,
// signed in or not, and bug-report.ts snapshots it into a durable
// bug-report-filed event at report time. Streaming entries to the project's
// /mobile-events stream is session-log-mirror.ts's job, subscribed via
// setSessionLogListener — this module deliberately imports nothing, so leaf
// modules like auth.ts can log without import cycles.

export const SESSION_STREAM_PATH = "/mobile-events";

export type SessionLogEntry = {
  at: string;
  type: string;
  payload: Record<string, unknown>;
};

const MAX_ENTRIES = 200;
const entries: SessionLogEntry[] = [];

/** The project whose /mobile-events stream mirrors the log — set by the
 * screen-view logger whenever the route says which project is open. */
let mirrorProjectId: string | null = null;

/** durable: errors and other rare, high-value facts the mirror should commit
 * to storage; everything else mirrors as `ephemeral: true`. */
type SessionLogListener = (entry: SessionLogEntry, options: { durable: boolean }) => void;
let listener: SessionLogListener | null = null;

export function setSessionLogListener(fn: SessionLogListener) {
  listener = fn;
}

export function setSessionProject(projectId: string | null) {
  mirrorProjectId = projectId;
}

export function getSessionProject() {
  return mirrorProjectId;
}

/** Snapshot of the ring buffer, oldest first. */
export function getSessionLog(): SessionLogEntry[] {
  return [...entries];
}

/**
 * Record a fact about what just happened. Ring buffer always; the mirror
 * (when installed) forwards it to the open project's /mobile-events stream
 * as an ephemeral event. Must never block or break the thing being logged.
 */
export function logEvent(type: string, payload: Record<string, unknown>) {
  record({ at: new Date().toISOString(), type, payload }, { durable: false });
}

/**
 * Record an error. Like logEvent, but mirrored durably — errors are rare and
 * high-value, and the bug report may come minutes later from a different
 * Durable Object incarnation.
 */
export function logError(source: string, error: unknown, extra?: Record<string, unknown>) {
  record(
    {
      at: new Date().toISOString(),
      type: "events.iterate.com/mobile/error-occurred",
      payload: {
        source,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack ? { stack: error.stack.slice(0, 2000) } : {}),
        ...extra,
      },
    },
    { durable: true },
  );
}

let lastScreenPathname: string | null = null;

/**
 * Called from render (deliberately not useEffect — see _layout.tsx), so it
 * must be idempotent per screen: only a pathname CHANGE is a fact worth
 * recording. Also keeps the mirror pointed at the project in the URL.
 */
export function logScreenView(pathname: string, params: Record<string, unknown>) {
  const projectId = typeof params.projectId === "string" ? params.projectId : null;
  if (projectId) setSessionProject(projectId);
  if (pathname === lastScreenPathname) return;
  lastScreenPathname = pathname;
  logEvent("events.iterate.com/mobile/screen-viewed", { pathname, params });
}

/**
 * Route unhandled JS errors through the log. Chained onto the previous
 * handler (RN's red screen in dev, crash reporting in release), never
 * replacing it. Call once from the root layout's module scope.
 */
export function installSessionErrorLogger() {
  const errorUtils = (globalThis as any).ErrorUtils;
  if (!errorUtils?.setGlobalHandler) return;
  const previous = errorUtils.getGlobalHandler?.();
  errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
    logError("unhandled", error, { isFatal: isFatal === true });
    previous?.(error, isFatal);
  });
}

function record(entry: SessionLogEntry, options: { durable: boolean }) {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  try {
    listener?.(entry, options);
  } catch {
    // The mirror must never break the thing being logged.
  }
}
