import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";
import YProvider from "y-partyserver/provider";
import { newWebSocketRpcSession } from "capnweb";
import type { CommitResult } from "../state.ts";
import type { CheckoutIndexEntry, TasksApi, TasksUser } from "./tasks-api.ts";
import { registerCollaborator } from "./checkout-shared.ts";
import { waitForWebSocketOpen } from "./websocket-ready.ts";

/**
 * The browser's end of a collaborative checkout: a stock y-partyserver
 * YProvider (the y-websocket wire) pointed at `/api/checkout/<id>`, carrying
 * the shared Y.Doc and everyone's presence. Auth is invisible here — the
 * project proxy stamps the session cookie on the upgrade like any request.
 */
export function useCheckout(checkoutId: string, repoPath: string) {
  const [handle, setHandle] = useState<{ provider: YProvider; doc: Y.Doc } | null>(null);

  useEffect(() => {
    const doc = new Y.Doc();
    // Change counter for useSyncExternalStore (the state vector alone would
    // miss deletions). Registered before any subscriber so it bumps first.
    doc.on("update", () => docVersions.set(doc, (docVersions.get(doc) ?? 0) + 1));
    const provider = new YProvider(window.location.host, `${repoPath}:${checkoutId}`, doc, {
      prefix: `/yjs/${encodeURIComponent(checkoutId)}`,
      params: { repoPath },
    });
    const user = localCollabUser();
    provider.awareness.setLocalStateField("user", user);
    // Also into the doc's collaborators map, so attribution outlives the
    // session (awareness forgets disconnected clients; the doc does not).
    registerCollaborator(doc, { name: user.name, color: user.color });
    setHandle({ provider, doc });
    return () => {
      setHandle(null);
      provider.destroy();
      doc.destroy();
    };
  }, [checkoutId, repoPath]);

  const provider = handle?.provider ?? null;
  const doc = handle?.doc ?? null;

  const subscribeStatus = useCallback(
    (listener: () => void) => {
      if (!provider) return () => {};
      provider.on("status", listener);
      provider.on("sync", listener);
      return () => {
        provider.off("status", listener);
        provider.off("sync", listener);
      };
    },
    [provider],
  );
  const status = useSyncExternalStore<"connecting" | "connected" | "ready" | "disconnected">(
    subscribeStatus,
    () => {
      if (!provider) return "connecting";
      if (provider.synced) return "ready";
      if (provider.wsconnected) return "connected";
      return provider.wsconnecting ? "connecting" : "disconnected";
    },
    () => "connecting",
  );

  const subscribeDoc = useCallback(
    (listener: () => void) => {
      if (!doc) return () => {};
      const onUpdate = () => listener();
      doc.on("update", onUpdate);
      return () => doc.off("update", onUpdate);
    },
    [doc],
  );
  const docVersion = useSyncExternalStore(
    subscribeDoc,
    () => (doc ? (docVersions.get(doc) ?? 0) : 0),
    () => 0,
  );

  const subscribeAwareness = useCallback(
    (listener: () => void) => {
      if (!provider) return () => {};
      const onChange = () => listener();
      provider.awareness.on("change", onChange);
      return () => provider.awareness.off("change", onChange);
    },
    [provider],
  );
  const awarenessVersion = useSyncExternalStore(
    subscribeAwareness,
    () => {
      if (!provider) return "";
      return [...provider.awareness.getStates().entries()]
        .map(([id, state]) => `${id}:${JSON.stringify(state)}`)
        .sort()
        .join("|");
    },
    () => "",
  );

  return { provider, doc, status, docVersion, awarenessVersion };
}

const docVersions = new WeakMap<Y.Doc, number>();

/**
 * The browser's live Cap'n Web session on the vessel's `/api` root — the
 * very same API an agent holds via `itx.worker.tasks`. Dialed lazily,
 * authenticated by the cookie riding the WebSocket upgrade (no explicit
 * token in browser land), shared by every op on the page, and redialed once
 * when a call finds the session broken.
 */
async function dialTasksApi() {
  const url = new URL("/api", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  await waitForWebSocketOpen(socket);
  const session = newWebSocketRpcSession<TasksApi>(socket);
  return { project: session.authenticate(), session, socket };
}

let liveApi: ReturnType<typeof dialTasksApi> | null = null;

/** One try on the LIVE session, no dispose/redial on failure — for
 * best-effort work (teardown flushes) that must never tear down the shared
 * WS under the poll and wait loops riding it. */
export async function withProjectOnce<T>(
  operation: (
    project: Awaited<ReturnType<typeof dialTasksApi>>["project"],
  ) => PromiseLike<T>,
): Promise<T> {
  liveApi ??= dialTasksApi();
  const current = liveApi;
  let api: Awaited<typeof current>;
  try {
    api = await current;
  } catch (cause) {
    if (liveApi === current) liveApi = null;
    throw cause;
  }
  return operation(api.project);
}

export async function withProject<T>(
  operation: (
    project: Awaited<ReturnType<typeof dialTasksApi>>["project"],
  ) => PromiseLike<T>,
): Promise<T> {
  liveApi ??= dialTasksApi();
  const current = liveApi;
  let api: Awaited<typeof current>;
  try {
    api = await current;
  } catch (cause) {
    if (liveApi === current) liveApi = null;
    throw cause;
  }
  try {
    return await operation(api.project);
  } catch (cause) {
    // Application errors belong to their caller. Only a transport that is
    // observably no longer OPEN invalidates the shared connection.
    if (api.socket.readyState !== WebSocket.OPEN && liveApi === current) liveApi = null;
    throw cause;
  }
}

export function commitCheckoutOp(
  checkoutId: string,
  repoPath: string,
  message: string,
): Promise<CommitResult> {
  return withProject((project) => project.checkout(checkoutId, repoPath).commit(message));
}

export function generateCheckoutMessageOp(checkoutId: string, repoPath: string): Promise<string> {
  return withProject((project) => project.checkout(checkoutId, repoPath).generateMessage());
}

export function assignAgentOp(
  checkoutId: string,
  repoPath: string,
  taskPath: string,
): Promise<{ agentPath: string }> {
  return withProject((project) => project.checkout(checkoutId, repoPath).assignAgent(taskPath));
}

/** The project's repos, for the sidebar's top-level hierarchy. */
export function listRepos(): Promise<string[]> {
  return withProject((project) => project.repos());
}

/** Every known checkout (from the project's index DO), newest activity first. */
export function listCheckouts(): Promise<CheckoutIndexEntry[]> {
  return withProject((project) => project.checkouts());
}

/** The platform-verified identity behind this browser's session. */
export function whoami(): Promise<TasksUser> {
  return withProject((project) => project.whoami());
}

/**
 * Overlay the verified identity on the local presence identity: the color
 * stays this browser's own, but the display name becomes the real one, and
 * userId/email ride awareness so peers can show who is who.
 */
export function applyVerifiedIdentity(provider: YProvider, user: TasksUser): CollabUser {
  const current = localCollabUser();
  const merged: CollabUser = {
    ...current,
    name: user.name ?? user.email ?? current.name,
    userId: user.userId ?? undefined,
    email: user.email ?? undefined,
    image: user.image ?? undefined,
  };
  provider.awareness.setLocalStateField("user", merged);
  registerCollaborator(provider.doc, {
    name: merged.name,
    color: merged.color,
    ...(merged.userId === undefined ? {} : { userId: merged.userId }),
    ...(merged.email === undefined ? {} : { email: merged.email }),
  });
  return merged;
}

/** The identity this browser collaborates as — persisted locally, renameable. */
export type CollabUser = {
  name: string;
  color: string;
  colorLight: string;
  /** Platform-verified fields, present once whoami() resolved. */
  userId?: string;
  email?: string;
  image?: string;
};

const IDENTITY_KEY = "tasks-collab-identity";
// Mid-tone palette: readable as text on the light theme, still saturated
// enough for cursors and presence dots. Violet is reserved for agents
// (AGENT_COLLABORATOR), so it stays out of the human draw.
const COLORS = [
  "#059669",
  "#d97706",
  "#4f46e5",
  "#dc2626",
  "#0891b2",
  "#0d9488",
  "#65a30d",
  "#db2777",
];
const ADJECTIVES = ["brisk", "calm", "deft", "keen", "merry", "quick", "sly", "warm"];
const ANIMALS = ["fox", "heron", "lynx", "otter", "raven", "seal", "stoat", "wren"];

export function localCollabUser(): CollabUser {
  try {
    const stored = window.localStorage.getItem(IDENTITY_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<CollabUser>;
      if (typeof parsed.name === "string" && typeof parsed.color === "string") {
        return { name: parsed.name, color: parsed.color, colorLight: `${parsed.color}55` };
      }
    }
  } catch {
    // fall through to a fresh identity
  }
  const name = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
  const color = pick(COLORS);
  const user = { name, color, colorLight: `${color}55` };
  try {
    window.localStorage.setItem(IDENTITY_KEY, JSON.stringify({ name, color }));
  } catch {
    // private mode — identity just won't persist
  }
  return user;
}

export function renameCollabUser(provider: YProvider, name: string): CollabUser {
  const current =
    ((provider.awareness.getLocalState() as { user?: CollabUser } | null)?.user ??
      localCollabUser());
  const user = { ...current, name: name.trim() || current.name };
  try {
    window.localStorage.setItem(IDENTITY_KEY, JSON.stringify({ name: user.name, color: user.color }));
  } catch {
    // ignore
  }
  provider.awareness.setLocalStateField("user", user);
  return user;
}

function pick<T>(values: readonly T[]): T {
  return values[Math.floor(Math.random() * values.length)]!;
}
