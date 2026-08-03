// The worker-side half of the wake-socket protocol (wake-socket.ts): the
// relay that makes a session connection's RPC leg droppable.
//
// The zero-return-frame wire guarantee, relay leg. The Stream DO retains and
// invokes the batch callback over Workers RPC, and Workers RPC always ships a
// call result — so if the DO's calls were forwarded straight through to the
// callback owner's Cap'n Web stub, the worker would have to PULL the
// callback's resolution to produce that result, putting one
// callback-originated resolve frame per batch on the socket (live-proven; see
// the one-way WebSocket case in stream-connections-and-subscriptions.e2e).
// Terminating the call HERE keeps the callback leg one-way: the forwarder
// invokes the callback owner's stub and disposes the result unpulled, and the
// DO's Workers RPC result is the forwarder's own synchronous `undefined`. The
// retained stubs are session-owned — Cap'n Web disposes a session's exports
// when the session ends, which is exactly a session connection's lifetime.
//
// The same decoupling makes the RPC leg droppable. A retained callback is a
// live capability into the Stream DO's isolate and pins it (billable
// duration) for the connection's whole life, so the relay also dials a
// hibernatable WAKE SOCKET through the DO stub's real fetch(). After the
// stream's idle window the DO severs the RPC leg, sends an idle frame (the
// relay drops its handle stub — itself a hibernation blocker), and hibernates
// at zero duration; the next matching append sends one wake frame and the
// relay re-dials openConnection from its exact delivered cursor. The caller's
// Cap'n Web leg — including the handle built from `open()`'s result, which is
// deliberately relay-local so ping() reflects the logical subscription rather
// than the current RPC leg — never observes the cycle.
//
// Delete this module (and wake-socket.ts) when hibernatable RPC ships.

import type {
  ProcessEventBatch,
  StreamConnectionHandle,
  StreamPingInput,
} from "iterate/processors";
import type { Stream } from "../../itx-api.generated.ts";
import type { StreamDurableObject } from "./stream-durable-object.ts";
import {
  retainConnectionPing,
  retainGetProcessorRuntimeState,
  retainProcessEventBatch,
} from "./retained-event-callbacks.ts";
import { parseWakeSocketFrame, STREAM_WAKE_SOCKET_HEADER } from "./wake-socket.ts";

/** What StreamConnectionRpcTarget's constructor needs; built here so rpc-targets.ts keeps owning the published target class. */
export type RelayedStreamConnection = {
  connectionKey: string;
  streamMaxOffset: number;
  isLive: () => boolean | Promise<boolean>;
  close: () => void;
};

/**
 * Open one session connection through the wake-socket relay.
 *
 * `stub` is a thunk on purpose: the Stream DO stub getter mints a fresh stub
 * per access, and a re-dial may happen hours after open, across DO resets —
 * a captured stub would inherit workerd's broken-stub semantics forever.
 */
export async function openRelayedStreamConnection(input: {
  stub: () => DurableObjectStub<StreamDurableObject>;
  args: Parameters<Stream["openConnection"]>[0];
}): Promise<RelayedStreamConnection> {
  const { args } = input;
  const connectionKey = args.connectionKey?.trim() || crypto.randomUUID();
  const wakeSocketId = crypto.randomUUID();

  // The retained wrappers hold the caller's Cap'n Web exports for the
  // LOGICAL subscription's lifetime, across every re-dial.
  const forward = retainProcessEventBatch(args.processEventBatch);
  const ping = retainConnectionPing(args.ping);
  const getRuntimeState = retainGetProcessorRuntimeState(args.getRuntimeState);
  const disposeRetained = () => {
    for (const dispose of [
      () => forward[Symbol.dispose](),
      () => ping?.[Symbol.dispose](),
      () => getRuntimeState?.[Symbol.dispose](),
    ]) {
      try {
        dispose();
      } catch {
        // Session teardown disposes exports concurrently; a double dispose is fine.
      }
    }
  };
  // `StreamConnectionHandle` includes `Disposable`, and over Workers RPC the
  // received stub implements it natively (releasing the remote reference).
  const disposeStub = (value: Disposable | undefined) => {
    try {
      value?.[Symbol.dispose]();
    } catch {
      // A broken stub has nothing left to release.
    }
  };

  let active = true;
  let closedByOwner = false;
  let dialing = false;
  let currentHandle: StreamConnectionHandle | undefined;
  let wakeSocket: WebSocket | undefined;
  let deliveredThroughOffset = args.replayAfterOffset;

  const forwardIntoDo = (batch: Parameters<ProcessEventBatch>[0]) => {
    deliveredThroughOffset = batch.scannedThroughOffset;
    void forward(batch);
  };

  const dial = (replayAfterOffset: number | undefined, redial: boolean) =>
    input.stub().openConnection(
      {
        // Spread so future openConnection args forward by construction (a
        // concurrent PR already grew this surface once); everything below
        // must be overridden and can never ride the spread.
        ...args,
        connectionKey,
        processEventBatch: forwardIntoDo,
        replayAfterOffset,
        // A re-dial resumes from the exact delivered cursor; the caller's
        // replay-gap guard applies only to the caller-chosen initial cursor.
        maxReplayOffsetGap: redial ? undefined : args.maxReplayOffsetGap,
        // Fresh plain arrows, NOT the retained objects: the retained wrappers
        // carry Symbol.dispose, and the DO releasing one leg's stub must not
        // cascade into disposing the session-lifetime Cap'n Web callbacks.
        getRuntimeState: getRuntimeState === undefined ? undefined : () => getRuntimeState(),
        ping: ping === undefined ? undefined : (pingInput: StreamPingInput) => ping(pingInput),
      },
      // Internal plumbing rides a separate parameter, never the public arg
      // bag: with the spread above, anything merged into `args`'s shape would
      // be client-spoofable by default.
      wakeSocket === undefined ? undefined : { wakeSocketId },
    );

  const probeLeg = (handle: StreamConnectionHandle) =>
    Promise.resolve()
      .then(() => handle.ping())
      .catch(() => false);

  /** The one terminal transition; every teardown path funnels here. */
  const teardown = (args2: { reason: string; socketCode: number; warn?: unknown }) => {
    if (!active) return;
    active = false;
    if (args2.warn !== undefined || !closedByOwner) {
      console.warn("stream connection relay closed", {
        connectionKey,
        reason: args2.reason,
        ...(args2.warn === undefined ? {} : { error: args2.warn }),
      });
    }
    try {
      wakeSocket?.close(args2.socketCode, args2.reason);
    } catch {
      // Already closed.
    }
    const handle = currentHandle;
    currentHandle = undefined;
    if (handle !== undefined && closedByOwner) {
      // Owner close is the one teardown where the DO-side connection should
      // be closed promptly rather than left to session-end disposal.
      void Promise.resolve()
        .then(() => handle.close())
        .catch(() => undefined)
        .finally(() => disposeStub(handle));
    } else {
      disposeStub(handle);
    }
    disposeRetained();
  };

  // Best-effort: without a wake socket the connection simply keeps today's
  // semantics — never idle-closed, pinned for the session's life.
  try {
    const upgrade = await input.stub().fetch("https://stream-wake.internal/", {
      headers: {
        Upgrade: "websocket",
        [STREAM_WAKE_SOCKET_HEADER]: JSON.stringify({ connectionKey, socketId: wakeSocketId }),
      },
    });
    wakeSocket = upgrade.webSocket ?? undefined;
    wakeSocket?.accept();
  } catch (error) {
    console.warn("stream wake socket unavailable; session connection will stay pinned", {
      connectionKey,
      error,
    });
  }

  wakeSocket?.addEventListener("message", (event) => {
    if (!active) return;
    const frame = parseWakeSocketFrame(event.data);
    if (frame === undefined) return;
    if (frame.type === "idle") {
      // The DO idle-closed the RPC leg. Dropping this handle stub releases
      // the relay's last live reference into the DO's isolate, which is what
      // lets the DO actually hibernate; the wake socket alone carries the
      // dormancy.
      const idled = currentHandle;
      currentHandle = undefined;
      disposeStub(idled);
      return;
    }
    if (dialing) return;
    dialing = true;
    void (async () => {
      try {
        const previous = currentHandle;
        if (previous !== undefined) {
          // A wake while a leg exists is either stale — sent in the gap
          // between socket accept and openConnection binding it, when the DO
          // saw an unstamped, connection-absent socket, and delivered after
          // the dial resolved — or the leg died without an idle frame (DO
          // eviction). Probing distinguishes them: a healthy leg makes the
          // frame a no-op instead of a spurious replace.
          if ((await probeLeg(previous)) === true || currentHandle !== previous) return;
        }
        currentHandle = undefined;
        disposeStub(previous);
        const fresh = await dial(deliveredThroughOffset, true);
        if (!active) {
          // The relay reached a terminal state while this dial was in
          // flight; adopting the fresh leg now would resurrect a closed
          // subscription as a socketless, permanently pinned connection.
          void Promise.resolve()
            .then(() => fresh.close())
            .catch(() => undefined)
            .finally(() => disposeStub(fresh));
          return;
        }
        currentHandle = fresh;
      } catch (error) {
        teardown({ reason: "wake re-dial failed", socketCode: 1011, warn: error });
      } finally {
        dialing = false;
      }
    })();
  });
  wakeSocket?.addEventListener("close", () => {
    wakeSocket = undefined;
    if (!active || closedByOwner) return;
    void (async () => {
      // While the RPC leg is live the socket was only a future optimization:
      // degrade to pinned mode (the DO's channel scan already sees the socket
      // gone). A dead socket while dormant means wakes can no longer arrive —
      // break, and the owner's watchdog re-subscribes.
      const handle = currentHandle;
      const live = handle === undefined ? false : await probeLeg(handle);
      if (live !== true) teardown({ reason: "wake socket closed while dormant", socketCode: 1000 });
    })();
  });

  // The dialing guard also covers this initial dial: a wake frame for a
  // just-bound socket must not race a second openConnection under it.
  dialing = true;
  try {
    currentHandle = await dial(args.replayAfterOffset, false);
  } catch (error) {
    closedByOwner = true;
    teardown({ reason: "open failed", socketCode: 1000 });
    throw error;
  } finally {
    dialing = false;
  }
  const streamMaxOffset = await currentHandle.streamMaxOffset;

  return {
    connectionKey,
    streamMaxOffset,
    // The owner's watchdog ping is the only periodic execution the relay
    // ever gets, so the probe doubles as the relay's heartbeat: it is the
    // one place a dead RPC leg (DO eviction, replaced connection) can be
    // noticed and its pinning stub released.
    isLive: () => {
      if (!active) return false;
      const handle = currentHandle;
      // Dormant: the wake socket carries liveness (its close breaks the relay).
      if (handle === undefined) return true;
      return probeLeg(handle).then((live) => {
        if (live === true || currentHandle !== handle) return active;
        // A gone leg with the wake socket still open is dormancy, not death —
        // the next matching append re-dials (the DO wakes any socket whose
        // connection is absent, stamped or not).
        currentHandle = undefined;
        disposeStub(handle);
        if (wakeSocket === undefined) {
          teardown({ reason: "rpc leg gone with no wake socket", socketCode: 1000 });
        }
        return active;
      });
    },
    close: () => {
      if (closedByOwner) return;
      closedByOwner = true;
      teardown({ reason: "closed-by-owner", socketCode: 1000 });
    },
  };
}
