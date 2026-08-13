// oxlint-disable react/only-export-components -- this public entry deliberately colocates its provider with the hooks that consume it.
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createLiveStateStore } from "./live-state/store.ts";
import type { LiveStateRpc, LiveStateSubscriptionHandle } from "./live-state/types.ts";

export type CapnWebRoot = object &
  Partial<Disposable> & {
    onRpcBroken?(callback: (error?: unknown) => void): void;
  };

export type MakeCapnWebConnection<Root extends CapnWebRoot> = () => Root | PromiseLike<Root>;
export type LiveStateStatus = "connecting" | "live" | "error";

type ConnectionSnapshot = {
  error?: string;
  generation: number;
  reconnect: () => void;
  root?: CapnWebRoot;
  /** Stable for one connection factory, across all of that factory's reconnects. */
  scope: object | undefined;
  status: "connecting" | "connected" | "error";
};

const CapnWebContext = createContext<ConnectionSnapshot | undefined>(undefined);
const CONNECTION_STABLE_MS = 30_000;
const CONNECTION_RETRY_MAX_MS = 10_000;
const SUBSCRIBE_RETRY_MS = 10_000;
const SUBSCRIBE_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 45_000;
const PING_TIMEOUT_MS = 10_000;

function releaseLiveStateSubscription(handle: LiveStateSubscriptionHandle): void {
  // Teardown commonly races a dead transport: the remote unsubscribe may
  // reject, but the local capability must still leave Cap'n Web's import table.
  void Promise.resolve()
    .then(() => handle.unsubscribe())
    .catch(() => {})
    .finally(() => handle[Symbol.dispose]?.());
}

/**
 * Own one reconnectable Cap'n Web root for a React subtree. The factory is the
 * only transport policy: it can dial a WebSocket directly or duplicate a root
 * from a lower-level shared connection keeper. Broken roots are disposed and
 * replaced with bounded exponential backoff.
 */
export function CapnWebProvider<Root extends CapnWebRoot>({
  children,
  makeConnection,
}: {
  children?: ReactNode;
  makeConnection: MakeCapnWebConnection<Root>;
}) {
  const snapshot = useCapnWebConnection(makeConnection);

  return createElement(CapnWebContext, { value: snapshot }, children);
}

function useCapnWebConnection<Root extends CapnWebRoot>(
  makeConnection: MakeCapnWebConnection<Root> | undefined,
  enabled = true,
): ConnectionSnapshot {
  const [epoch, setEpoch] = useState(0);
  const failures = useRef(0);
  const failureSource = useRef(makeConnection);
  const reconnect = useCallback(() => setEpoch((current) => current + 1), []);
  const [snapshot, setSnapshot] = useState<InternalConnectionSnapshot<Root>>({
    enabled,
    generation: 0,
    reconnect,
    source: makeConnection,
    status: "connecting",
  });

  // react-doctor-disable-next-line effect-needs-cleanup -- the unconditional cleanup below owns both timers assigned by async connection callbacks and the root
  useEffect(() => {
    let disposed = false;
    let root: Root | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stable: ReturnType<typeof setTimeout> | undefined;
    if (failureSource.current !== makeConnection) {
      failureSource.current = makeConnection;
      failures.current = 0;
    }
    if (!enabled || !makeConnection) {
      failures.current = 0;
      setSnapshot((current) => ({
        enabled,
        generation: current.generation,
        reconnect,
        source: makeConnection,
        status: "connecting",
      }));
    } else {
      const scheduleReconnect = () => {
        const nextFailures = (failures.current += 1);
        retry = setTimeout(
          reconnect,
          Math.min(250 * 2 ** (nextFailures - 1), CONNECTION_RETRY_MAX_MS),
        );
      };
      setSnapshot((current) => ({
        enabled,
        generation: current.generation,
        reconnect,
        source: makeConnection,
        status: "connecting",
      }));

      void Promise.resolve(makeConnection()).then(
        (connected) => {
          if (disposed) {
            connected[Symbol.dispose]?.();
            return;
          }
          root = connected;
          setSnapshot((current) => ({
            enabled,
            generation: current.generation + 1,
            reconnect,
            root: connected,
            source: makeConnection,
            status: "connected",
          }));
          stable = setTimeout(() => {
            if (!disposed && root === connected) failures.current = 0;
          }, CONNECTION_STABLE_MS);
          connected.onRpcBroken?.(() => {
            if (disposed || root !== connected) return;
            clearTimeout(stable);
            root = undefined;
            connected[Symbol.dispose]?.();
            setSnapshot((current) => ({
              enabled,
              generation: current.generation,
              reconnect,
              source: makeConnection,
              status: "connecting",
            }));
            scheduleReconnect();
          });
        },
        (cause: unknown) => {
          if (disposed) return;
          setSnapshot((current) => ({
            enabled,
            error: cause instanceof Error ? cause.message : String(cause),
            generation: current.generation,
            reconnect,
            source: makeConnection,
            status: "error",
          }));
          scheduleReconnect();
        },
      );
    }

    return () => {
      disposed = true;
      clearTimeout(retry);
      clearTimeout(stable);
      root?.[Symbol.dispose]?.();
    };
  }, [enabled, epoch, makeConnection, reconnect]);

  if (snapshot.enabled !== enabled || snapshot.source !== makeConnection) {
    return {
      generation: snapshot.generation,
      reconnect,
      scope: makeConnection,
      status: "connecting",
    };
  }
  const { enabled: _enabled, source: _source, ...connection } = snapshot;
  return { ...connection, scope: makeConnection };
}

type InternalConnectionSnapshot<Root extends CapnWebRoot> = Omit<ConnectionSnapshot, "scope"> & {
  enabled: boolean;
  source: MakeCapnWebConnection<Root> | undefined;
};

/** The current provider root, undefined while its connection is being replaced. */
export function useCapnWebRoot<Root extends CapnWebRoot>(): Root | undefined {
  const connection = useContext(CapnWebContext);
  if (!connection) {
    throw new Error("useCapnWebRoot must be rendered under <CapnWebProvider>.");
  }
  return connection.root as Root | undefined;
}

/**
 * Render a selected slice of any LiveStateRpc reachable from the provider root.
 * Pass `{ root }` to borrow an explicit root instead; borrowed roots are never
 * disposed or reconnected by this hook.
 */
export function useLiveState<Root extends CapnWebRoot, State, Selected = State>(
  live: (root: Root) => LiveStateRpc<State>,
  selector: (state: State) => Selected = (state) => state as unknown as Selected,
  deps: unknown[] = [],
  options?: {
    enabled?: boolean;
    makeConnection?: MakeCapnWebConnection<Root>;
    root?: Root | null;
  },
): {
  error?: string;
  refresh: () => void;
  status: LiveStateStatus;
  value: Selected | undefined;
} {
  const provider = useContext(CapnWebContext);
  const hasRootOverride = !!options && Object.hasOwn(options, "root");
  const connectionFactory = hasRootOverride ? undefined : options?.makeConnection;
  const owned = useCapnWebConnection(
    connectionFactory,
    !hasRootOverride && (options?.enabled ?? true),
  );
  const hasConnectionOverride = !!connectionFactory;
  if (!hasRootOverride && !hasConnectionOverride && !provider) {
    throw new Error(
      "useLiveState needs <CapnWebProvider>, a makeConnection option, or an explicit { root } override.",
    );
  }
  const connection = hasRootOverride ? undefined : hasConnectionOverride ? owned : provider;
  const root = (hasRootOverride ? options.root : connection?.root) ?? undefined;
  const enabled = options?.enabled ?? true;
  const [epoch, setEpoch] = useState(0);
  const refresh = useCallback(() => setEpoch((current) => current + 1), []);
  const liveRef = useRef(live);
  const selectorRef = useRef(selector);
  useEffect(() => {
    liveRef.current = live;
    selectorRef.current = selector;
  });

  // A different provider/factory, explicit borrowed root, or logical node gets
  // an empty store synchronously. A new transport generation within the same
  // connection scope keeps the last value visible while it re-subscribes.
  const logicalConnection = hasRootOverride
    ? root
    : hasConnectionOverride
      ? connectionFactory
      : connection?.scope;
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- this memo is intentionally keyed; deps complete the caller's logical-node identity
  const store = useMemo(() => createLiveStateStore<State>(), [logicalConnection, ...deps]);
  const [subscriptionState, setSubscriptionState] = useState<{
    error?: string;
    epoch: number;
    generation: number | undefined;
    status: LiveStateStatus;
    store: typeof store;
  }>({ epoch, generation: connection?.generation, status: "connecting", store });

  // react-doctor-disable-next-line effect-needs-cleanup -- the unconditional cleanup below owns subscribe/retry/ping timers and the subscription handle
  useEffect(() => {
    let disposed = false;
    let stale = false;
    let handle: LiveStateSubscriptionHandle | undefined;
    let pingTimeout: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    const release = () => {
      stale = true;
      if (!handle) return;
      releaseLiveStateSubscription(handle);
      handle = undefined;
    };
    setSubscriptionState({
      epoch,
      generation: connection?.generation,
      status: "connecting",
      store,
    });
    if (enabled && root) {
      const report = (cause: unknown, shouldRetry = false) => {
        if (disposed || stale) return;
        release();
        setSubscriptionState({
          error: cause instanceof Error ? cause.message : String(cause),
          epoch,
          generation: connection?.generation,
          status: "error",
          store,
        });
        if (shouldRetry) retry = setTimeout(refresh, SUBSCRIBE_RETRY_MS);
      };

      // The context erases its root parameter; this hook's provider/factory/root
      // inputs are the only sources, so restoring the caller's Root is safe.
      try {
        const pending = liveRef.current(root as Root).subscribe((update) => {
          if (disposed || stale) return;
          store.apply(update, refresh);
        });
        timeout = setTimeout(
          () =>
            report(
              new Error(`live-state subscription timed out after ${SUBSCRIBE_TIMEOUT_MS}ms`),
              true,
            ),
          SUBSCRIBE_TIMEOUT_MS,
        );
        void Promise.resolve(pending).then(
          (subscription) => {
            clearTimeout(timeout);
            if (disposed || stale) {
              releaseLiveStateSubscription(subscription);
              return;
            }
            handle = subscription;
            setSubscriptionState({
              epoch,
              generation: connection?.generation,
              status: "live",
              store,
            });
            watchdog = setInterval(() => {
              if (!handle) return;
              void Promise.race([
                Promise.resolve(handle.ping()),
                new Promise<boolean>((resolve) => {
                  pingTimeout = setTimeout(() => resolve(false), PING_TIMEOUT_MS);
                }),
              ])
                .then(
                  (alive) => {
                    if (!disposed && !alive) refresh();
                  },
                  (cause: unknown) => report(cause, true),
                )
                .finally(() => clearTimeout(pingTimeout));
            }, PING_INTERVAL_MS);
          },
          (cause: unknown) => {
            clearTimeout(timeout);
            report(cause);
          },
        );
      } catch (cause) {
        report(cause);
      }
    }

    return () => {
      disposed = true;
      clearTimeout(pingTimeout);
      clearTimeout(timeout);
      clearTimeout(retry);
      clearInterval(watchdog);
      release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps define the caller's logical node
  }, [connection?.generation, enabled, epoch, root, store, ...deps]);

  const selected = useRef<{ state: State | undefined; value: Selected | undefined }>({
    state: undefined,
    value: undefined,
  });
  const getSelected = () => {
    const state = store.getState();
    if (Object.is(selected.current.state, state)) return selected.current.value;
    // oxlint-disable-next-line iterate/simple-truthiness-check -- live state may be any JSON value, falsy included; only undefined means "no state yet"
    const value = state === undefined ? undefined : selectorRef.current(state);
    selected.current = { state, value };
    return value;
  };
  const value = useSyncExternalStore(store.subscribe, getSelected, () => undefined);
  const providerError =
    !hasRootOverride && connection?.status === "error" ? connection.error : undefined;
  const activeSubscriptionState =
    subscriptionState.store === store &&
    subscriptionState.epoch === epoch &&
    subscriptionState.generation === connection?.generation
      ? subscriptionState
      : {
          epoch,
          generation: connection?.generation,
          status: "connecting" as const,
          store,
        };
  const connectionIsConnecting = !hasRootOverride && connection?.status === "connecting";
  return {
    error:
      providerError ??
      (connectionIsConnecting || !enabled ? undefined : activeSubscriptionState.error),
    refresh: !hasRootOverride && connection?.status === "error" ? connection.reconnect : refresh,
    status: providerError
      ? "error"
      : connectionIsConnecting || !enabled
        ? "connecting"
        : activeSubscriptionState.status,
    value,
  };
}
