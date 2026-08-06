// The worker-side half of the stream-subscriber-pager protocol (stream-subscriber-pager.ts): the
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
// client gives the DO a hibernatable Subscriber Pager through the DO stub's
// real fetch(): "you may release my RPC leg; Page me here when you need me."
// After the stream's idle window the DO severs the RPC leg, sends an idle Page
// (the relay drops its handle stub — itself a hibernation blocker), and
// hibernates at zero duration. The next matching append sends one work Page,
// and the relay lends the DO a new RPC leg by re-dialing openConnection from
// its exact delivered cursor. The caller's
// Cap'n Web leg — including the handle built from `open()`'s result, which is
// deliberately relay-local so ping() reflects the logical subscription rather
// than the current RPC leg — never observes the cycle.
//
// Delete this module (and stream-subscriber-pager.ts) when hibernatable RPC ships.

import type {
  ProcessEventBatch,
  StreamConnectionHandle,
  StreamPingInput,
} from "iterate/processors";
import { z } from "zod";
import type { Stream } from "../../itx-api.generated.ts";
import { dialHibernatablePager, parseHibernatablePage } from "../hibernatable-pager.ts";
import {
  retainConnectionPing,
  retainGetProcessorRuntimeState,
  retainProcessEventBatch,
} from "./retained-event-callbacks.ts";
import type { StreamDurableObject } from "./stream-durable-object.ts";
import { STREAM_SUBSCRIBER_PAGER_HEADER } from "./stream-subscriber-pager.ts";

const StreamSubscriberPage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("page") }),
]);

/** What StreamConnectionRpcTarget's constructor needs; built here so rpc-targets.ts keeps owning the published target class. */
type RelayedStreamConnection = {
  connectionKey: string;
  streamMaxOffset: number;
  isLive: () => boolean | Promise<boolean>;
  close: () => void;
};

/**
 * Open one session connection through the stream-subscriber-pager relay.
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
  const subscriberPagerId = crypto.randomUUID();

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
  let subscriberPager: WebSocket | undefined;
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
      subscriberPager === undefined ? undefined : { subscriberPagerId },
    );

  const probeLeg = (handle: StreamConnectionHandle) =>
    Promise.resolve()
      .then(() => handle.ping())
      .catch(() => false);

  // A Workers RPC capability from an aborted Durable Object can keep
  // returning its captured in-memory `true` indefinitely. Ask a fresh stub
  // about this exact relay/socket pair so liveness comes from the current
  // incarnation. A deliberately idle relay remains logically alive; a socket
  // absent from the current incarnation is orphaned even if its local endpoint
  // has not emitted `close`.
  const probeRelayState = () =>
    Promise.resolve()
      .then(() => input.stub().relayedConnectionState({ connectionKey, subscriberPagerId }))
      .catch(() => "dead" as const);

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
      subscriberPager?.close(args2.socketCode, args2.reason);
    } catch {
      // Already closed.
    }
    const handle = currentHandle;
    currentHandle = undefined;
    if (handle !== undefined) {
      // Always attempt the prompt DO-side close, whatever ended the relay: a
      // teardown triggered by a transient probe failure can hold a HEALTHY
      // leg, and merely disposing it would leave a zombie connection —
      // socketless, so never idle-eligible — delivering into the disposed
      // forward until session end. A genuinely broken stub just rejects.
      void Promise.resolve()
        .then(() => handle.close())
        .catch(() => undefined)
        .finally(() => disposeStub(handle));
    }
    disposeRetained();
  };

  // Best-effort: without a Pager the connection simply keeps today's
  // semantics — never idle-closed, pinned for the session's life.
  try {
    subscriberPager = await dialHibernatablePager({
      headerName: STREAM_SUBSCRIBER_PAGER_HEADER,
      headerValue: { connectionKey, pagerId: subscriberPagerId },
      stub: input.stub(),
      url: "https://stream-subscriber-pager.internal/",
    });
  } catch (error) {
    console.warn("stream Subscriber Pager unavailable; session connection will stay pinned", {
      connectionKey,
      error,
    });
  }

  subscriberPager?.addEventListener("message", (event) => {
    if (!active) return;
    const page = parseHibernatablePage(event.data, StreamSubscriberPage);
    if (page === undefined) return;
    if (page.type === "idle") {
      // The DO idle-closed the RPC leg. Dropping this handle stub releases
      // the relay's last live reference into the DO's isolate, which is what
      // lets the DO actually hibernate; the Pager alone carries the
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
          // A Page while a leg exists is either stale — sent in the gap
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
        teardown({ reason: "Pager re-dial failed", socketCode: 1011, warn: error });
      } finally {
        dialing = false;
      }
    })();
  });
  subscriberPager?.addEventListener("close", () => {
    subscriberPager = undefined;
    if (!active || closedByOwner) return;
    void (async () => {
      // While the RPC leg is live the Pager was only a future optimization:
      // degrade to pinned mode (the DO's Pager scan already sees it gone). If
      // the leg died with the Pager, recover from the relay's exact cursor
      // immediately. That replacement has no Pager, so it stays
      // pinned for the rest of this logical subscription instead of silently
      // losing events until the owner's next watchdog round.
      const handle = currentHandle;
      const live = handle === undefined ? false : await probeLeg(handle);
      if (live === true || currentHandle !== handle || dialing) return;
      currentHandle = undefined;
      disposeStub(handle);
      dialing = true;
      try {
        const fresh = await dial(deliveredThroughOffset, true);
        if (!active) {
          void Promise.resolve()
            .then(() => fresh.close())
            .catch(() => undefined)
            .finally(() => disposeStub(fresh));
          return;
        }
        currentHandle = fresh;
        console.warn("stream Subscriber Pager closed; session connection resumed in pinned mode", {
          connectionKey,
        });
      } catch (error) {
        teardown({ reason: "Subscriber Pager recovery failed", socketCode: 1011, warn: error });
      } finally {
        dialing = false;
      }
    })();
  });

  // The dialing guard also covers this initial dial: a Page for a just-bound
  // Pager must not race a second openConnection under it.
  dialing = true;
  try {
    const fresh = await dial(args.replayAfterOffset, false);
    if (!active) {
      // The socket-close handler tore the relay down while this dial was in
      // flight (reachable when bind's oversized-attachment degrade closes
      // the socket in the same openConnection turn). Adopting the leg would
      // hand back a connection whose forward is already disposed —
      // socketless, never idle-eligible, silently swallowing every delivery.
      void Promise.resolve()
        .then(() => fresh.close())
        .catch(() => undefined)
        .finally(() => disposeStub(fresh));
      throw new Error(`stream connection relay closed while opening "${connectionKey}"`);
    }
    currentHandle = fresh;
  } catch (error) {
    closedByOwner = true;
    teardown({ reason: "open failed", socketCode: 1000 });
    throw error;
  } finally {
    dialing = false;
  }
  let streamMaxOffset: number;
  try {
    streamMaxOffset = await currentHandle.streamMaxOffset;
  } catch (error) {
    // The leg opened but died before answering; without teardown here the
    // caller would see an open failure while the socket, handle stub, and
    // retained callbacks all stayed live — an orphaned pin with no owner.
    closedByOwner = true;
    teardown({ reason: "open failed reading streamMaxOffset", socketCode: 1000 });
    throw error;
  }
  // Seed the resume cursor for callers that omitted replayAfterOffset ("new
  // events only"): the head observed at open is that intent's exact baseline.
  // Without it, an idle teardown before the first batch reaches this relay
  // would make the Page-driven re-dial open at the DO's CURRENT head and skip every
  // event committed during dormancy — including the one that woke it.
  deliveredThroughOffset ??= streamMaxOffset;

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
      const pager = subscriberPager;
      if (pager !== undefined) {
        return probeRelayState().then((state) => {
          if (currentHandle !== handle || subscriberPager !== pager) return active;
          if (state === "live") return active;
          if (state === "dormant") {
            currentHandle = undefined;
            disposeStub(handle);
            return active;
          }
          teardown({
            reason: "Subscriber Pager absent from current stream incarnation",
            socketCode: 1000,
          });
          return false;
        });
      }
      // Pagerless pinned mode owns only the RPC leg.
      if (handle === undefined) return true;
      return probeLeg(handle).then((live) => {
        if (live === true || currentHandle !== handle) return active;
        // An idle frame clears currentHandle before the ordinary dormant state
        // reaches this branch. A handle that was present and now fails its
        // probe is therefore dead even when the local Pager endpoint
        // still LOOKS open: ctx.abort() can orphan that endpoint without a
        // close event or a socket in the next DO incarnation. Report false so
        // the owner reopens from its durable cursor instead of waiting forever
        // for a Page that can no longer exist.
        currentHandle = undefined;
        disposeStub(handle);
        if (subscriberPager === undefined) {
          teardown({ reason: "rpc leg gone with no Subscriber Pager", socketCode: 1000 });
        }
        return false;
      });
    },
    close: () => {
      if (closedByOwner) return;
      closedByOwner = true;
      teardown({ reason: "closed-by-owner", socketCode: 1000 });
    },
  };
}
