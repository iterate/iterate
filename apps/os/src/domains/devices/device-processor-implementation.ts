import { isIdempotencyConflict, StreamProcessor } from "iterate/processors";
import type { EmittedInput, ProcessEventArgs, ReduceArgs } from "iterate/processors";
import {
  DeviceProcessorContract,
  type DeviceNotificationOutcome,
  type DeviceProcessorState,
} from "./device-processor-contract.ts";

/**
 * One enrolled mobile installation and its push-notification obligations.
 *
 * HOW IT WORKS, end to end:
 *
 * Enrollment happens in the device Durable Object: it stores the Expo push
 * token in a write-only Secret and appends `device/created` carrying only the
 * Secret's path and update offset — the token never rides this stream. The
 * created event's per-event lane copies the birth fact to the project
 * root stream (the catalog the project processor lists devices from) and
 * configures a notification-intent subscription there, so every project-level
 * `notification/requested` intent is copied onto this device stream.
 * `push-token-updated` re-arms that rule (re-enrollment also clears a
 * standing revocation); `device/revoked` removes it.
 *
 * A push obligation opens when a `device/notification-requested` (direct) or
 * `notification/requested` (copied intent) event reduces into
 * `state.notifications`, keyed by the requesting event's OFFSET — the
 * obligation's identity; there are no synthetic ids anywhere, and every later
 * fact points back with that requestOffset.
 *
 * All sending is state-derived: the at-head pass in `processEvent` walks the
 * open obligations and, for each `requested` entry with a live credential and
 * time on the clock, appends `notification-attempt-started` (durable evidence,
 * BEFORE the vendor is dialed), dials Expo, and records the returned receipt
 * ticket as `notification-ticket-observed`. A ticket is Expo accepting the
 * payload, not delivery — the receipt check later resolves what APNs/FCM did.
 * The vendor wait is bounded even while this incarnation stays alive: a send
 * that rejects or misses its deadline settles uncertain, because Expo may
 * already have accepted it and a retry could ring the phone twice.
 * The same pass settles what can no longer be attempted: `requested` past its
 * `expiresAt` settles expired; `requested` with no credential settles
 * device-unavailable; `started` with nobody in this incarnation's live-set
 * settles uncertain (the incarnation died mid-attempt and Expo may have
 * accepted the push, so it is deliberately NOT retried). Every settlement is
 * idempotency-keyed on the requestOffset, so the expiry sweep, the send path,
 * and the receipt check collapse to one terminal fact.
 *
 * Approval-batch obligations (their request carries an
 * approvalRequestEventOffset) additionally wait `config.approvalGraceMs`
 * before any attempt: a client already showing the batch appends a
 * `project/approval-presented` claim to the project root stream (the same
 * subscription copies it here), and a claim that reduces while the obligation
 * is still `requested` settles it `suppressed` — the phone must not ring
 * about something on screen. A grace expiry appends no event, so the at-head
 * pass points the DO's grace alarm slice at the earliest pending expiry and
 * the alarm calls `releaseGraces` to run the send outside delivery
 * (the receipt check's exact shape). A claim arriving after the attempt
 * started is a no-op.
 *
 * Chat-reply obligations (their request carries an agentReplyEventOffset)
 * work the same way with `config.replyGraceMs` and the
 * `project/agent-reply-presented` claim, matched on the (destination path,
 * reply offset) pair — with one addition: reduced claims are remembered in
 * `state.recentReplyClaims` (bounded, deterministically pruned), so an
 * intent copied AFTER its claim still opens pre-claimed. Approvals accept
 * that race because their request always commits long before a client can
 * render the batch; a reply's claim and intent are both triggered by the
 * same reply event, so for replies the race is real and losing it would
 * ring a phone the user is actively looking at.
 *
 * User-scoped intents (`audience: {kind:"user"}`) reduce to obligations only
 * on devices whose enrollment ownerId matches; other devices never open the
 * obligation at all.
 *
 * Receipts run outside delivery: the at-head pass points the Durable Object's
 * alarm slice at the earliest due check (`ticketObservedAt` +
 * `config.receiptCheckDelayMs`), and the DO's alarm calls `checkReceipts` with
 * the current state. An accepted/rejected receipt settles the obligation; a
 * pending one re-arms the alarm; past `config.receiptRetentionMs` the outcome
 * is permanently unknowable and settles uncertain. A DeviceNotRegistered
 * answer — from the send call or a receipt — compare-and-clears the push-token
 * Secret at the credential revision the attempt was made with
 * (`pushTokenSecretUpdatedOffset`), so a stale rejection can never erase a
 * credential rotated while the attempt was in flight; only a successful clear
 * appends `device/revoked`.
 *
 * Recovery is the standard shape: the DO registers this processor with
 * recovery, so an incarnation that dies owing background work gets a
 * `stream/processor-revived` fact whose wake produces the eventless at-head
 * pass — orphaned attempts settle, still-runnable requests start, the receipt
 * alarm re-arms.
 */
export class DeviceProcessor extends StreamProcessor<DeviceProcessorContract, DeviceProcessorDeps> {
  readonly contract = DeviceProcessorContract;

  /**
   * RUNTIME state: the requestOffsets THIS incarnation is currently sending,
   * in-memory, dead with every eviction — and that is fine: the durable truth
   * is the attempt-started fact, and the at-head pass settles a `started`
   * obligation nobody here is driving as uncertain instead of re-dialing Expo.
   */
  readonly #liveSendAttempts = new Set<number>();

  // ------------------------------------------------------------ processEvent
  // The side-effect lanes are chosen HERE, at the dispatch site, never inside
  // helpers:
  //
  // - PER-EVENT consequences (the created/updated/revoked copies to the
  //   project root stream) use `blockProcessorWhile`: each rides an event
  //   delivered once — a dropped append would lose the catalog entry or leave
  //   the intent subscription wrong forever.
  // - STATE-DERIVED consequences (everything under `delivery.caughtUp`) use
  //   `runInBackground`: any later at-head delivery re-derives them from the
  //   same reduced state, and the recovery revival guarantees such a delivery
  //   after an eviction.
  protected override processEvent(args: ProcessEventArgs<DeviceProcessorContract>): undefined {
    const { event, state, delivery, blockProcessorWhile, runInBackground, append, appendTo } = args;

    switch (event?.type) {
      case "events.iterate.com/device/created":
        blockProcessorWhile(() =>
          appendTo(
            "/",
            {
              type: "events.iterate.com/device/created",
              idempotencyKey: this.idempotencyKey("catalog-created", event),
              payload: event.payload,
            },
            notificationIntentSubscriptionEvent({
              idempotencyKey: this.idempotencyKey("notification-intent-subscription", event),
              path: this.path,
            }),
          ),
        );
        break;
      case "events.iterate.com/device/push-token-updated":
        blockProcessorWhile(() =>
          appendTo(
            "/",
            notificationIntentSubscriptionEvent({
              idempotencyKey: this.idempotencyKey("notification-intent-subscription", event),
              path: this.path,
            }),
          ),
        );
        break;
      case "events.iterate.com/device/revoked":
        blockProcessorWhile(() =>
          appendTo("/", {
            type: "events.iterate.com/stream/subscription-removed",
            idempotencyKey: this.idempotencyKey("notification-intent-subscription-removed", event),
            payload: {
              name: `notification-intent:${this.path}`,
              reason: "requested",
            },
          }),
        );
        break;
      // notification-requested / attempt-started / ticket-observed / settled /
      // opened: no per-event effect — they matter through the reduced state
      // below.
    }

    // ---------------------------------------- state-derived side effects
    // Plain code over the reduced state, after every delivery. Act only at
    // head — behind it the state is partial and settlements may sit in pages
    // not yet replayed.
    if (!delivery.caughtUp || !state.birthCertificate) return;
    const { pushTokenSecret } = state;

    // Settle what can no longer be attempted. Whether an orphaned `started`
    // attempt fails or re-drives is a domain decision: pushes fail-uncertain,
    // because Expo may have accepted the original and a retry would ring the
    // user's phone twice.
    const settlements: { requestOffset: number; outcome: DeviceNotificationOutcome }[] = [];
    for (const [offset, notification] of Object.entries(state.notifications)) {
      const requestOffset = Number(offset);
      if (notification.status === "requested" && Number.isFinite(notification.presentedAt)) {
        // A claim landed while the obligation was still unattempted: the user
        // is already looking at the batch, so the push dies here — checked
        // before expiry because both mean "never dial Expo" and suppression
        // is the truer account.
        settlements.push({ requestOffset, outcome: { kind: "suppressed" } });
      } else if (notification.status === "requested" && notification.expiresAt <= this.deps.now()) {
        settlements.push({ requestOffset, outcome: { kind: "expired" } });
      } else if (notification.status === "requested" && !pushTokenSecret) {
        settlements.push({ requestOffset, outcome: { kind: "device-unavailable" } });
      } else if (notification.status === "started" && !this.#liveSendAttempts.has(requestOffset)) {
        settlements.push({
          requestOffset,
          outcome: {
            kind: "uncertain",
            phase: "expo-send",
            reason:
              "The processor incarnation disappeared after recording the attempt start; Expo may have accepted the push, so it was not retried.",
          },
        });
      }
    }
    // Ticketed obligations wait for their Expo receipt outside delivery: point
    // the Durable Object's alarm at the earliest due check.
    const nextReceiptCheck = Object.values(state.notifications)
      .filter(
        (notification) =>
          notification.status === "ticketed" && Number.isFinite(notification.ticketObservedAt),
      )
      .reduce<number | null>((earliest, notification) => {
        const at = notification.ticketObservedAt! + state.config.receiptCheckDelayMs;
        return !Number.isFinite(earliest) || at < earliest ? at : earliest;
      }, null);
    // Claimable obligations (approval batches, chat replies) inside their
    // grace window wait for a claim that may never come, and a grace expiry
    // appends NO event — so point the DO's grace alarm slice at the earliest
    // pending expiry; its firing calls releaseGraces below.
    const nextGraceExpiry = this.#nextGraceExpiry(state);
    if (
      settlements.length ||
      Number.isFinite(nextReceiptCheck) ||
      Number.isFinite(nextGraceExpiry)
    ) {
      runInBackground(async () => {
        if (settlements.length) {
          // Race-tolerant: the alarm-driven receipt check (or a raced sibling
          // pass) may settle the same requestOffset with a different outcome
          // first — the first-committed settlement stands, and once it reduces
          // the obligation is gone from state, so nothing re-derives here.
          await this.#appendUnlessLostIdempotencyRace(
            append,
            settlements.map(({ outcome, requestOffset }) => ({
              type: "events.iterate.com/device/notification-settled" as const,
              idempotencyKey: this.idempotencyKey(`notification-settled@${requestOffset}`),
              payload: { requestOffset, outcome },
            })),
          );
        }
        if (Number.isFinite(nextReceiptCheck)) {
          await this.deps.repointReceiptAlarm(nextReceiptCheck);
        }
        if (Number.isFinite(nextGraceExpiry)) {
          await this.deps.repointGraceAlarm(nextGraceExpiry);
        }
      });
    }

    // Start a send attempt for every runnable `requested` obligation nobody
    // in this incarnation is already driving. The live-set entry is taken
    // SYNCHRONOUSLY, before any await, so the same pass never classifies its
    // own attempt as orphaned.
    if (!pushTokenSecret || !this.projectId) return;
    for (const [offset, notification] of Object.entries(state.notifications)) {
      const requestOffset = Number(offset);
      // A claimable obligation is not runnable until its grace window
      // elapses (giving a foregrounded client time to claim it), and never
      // once claimed — the sweep above settles claimed ones `suppressed`.
      const graceUntil = obligationGraceUntil(notification, state.config);
      if (
        notification.status !== "requested" ||
        notification.expiresAt <= this.deps.now() ||
        Number.isFinite(notification.presentedAt) ||
        this.deps.now() < graceUntil ||
        this.#liveSendAttempts.has(requestOffset)
      ) {
        continue;
      }
      this.#liveSendAttempts.add(requestOffset);
      runInBackground(() =>
        this.#sendNotification({
          notification,
          pushTokenSecretPath: pushTokenSecret.path,
          pushTokenSecretUpdatedOffset: pushTokenSecret.updatedOffset,
          requestOffset,
        }),
      );
    }
  }

  // ------------------------------------------------------------------ reduce
  // Pure, one switch, cases inline.
  protected override reduce({ event, state }: ReduceArgs<DeviceProcessorContract>) {
    switch (event.type) {
      case "events.iterate.com/device/created":
        // Duplicate birth facts must not wedge an already-committed frame.
        // Conflicting create retries fail earlier at stream idempotency.
        if (state.birthCertificate) return state;
        return {
          ...state,
          birthCertificate: event.payload,
          pushTokenSecret: {
            path: event.payload.config.pushTokenSecretPath,
            updatedOffset: event.payload.config.pushTokenSecretUpdatedOffset,
          },
          tokenUpdatedOffset: event.offset,
        };
      case "events.iterate.com/device/push-token-updated":
        return {
          ...state,
          // The birth certificate tracks the CURRENT enrollment: every field
          // replaced except the immutable platform.
          birthCertificate: !state.birthCertificate
            ? null
            : {
                config: {
                  appVersion: event.payload.appVersion,
                  label: event.payload.label,
                  notificationsStatus: event.payload.notificationsStatus,
                  ownerId: event.payload.ownerId,
                  platform: state.birthCertificate.config.platform,
                  pushTokenSecretPath: event.payload.pushTokenSecretPath,
                  pushTokenSecretUpdatedOffset: event.payload.pushTokenSecretUpdatedOffset,
                },
              },
          pushTokenSecret: {
            path: event.payload.pushTokenSecretPath,
            updatedOffset: event.payload.pushTokenSecretUpdatedOffset,
          },
          // Re-enrollment: a fresh credential un-revokes the device.
          revokedAt: null,
          tokenUpdatedOffset: event.offset,
        };
      case "events.iterate.com/device/revoked":
        return {
          ...state,
          pushTokenSecret: null,
          revokedAt: event.createdAt,
        };
      case "events.iterate.com/device/notification-requested":
      case "events.iterate.com/notification/requested": {
        // Both doors open the same obligation slot, keyed by the requesting
        // event's offset. The intent's audience resolves HERE, at reduce: a
        // user-scoped intent on a device another user enrolled opens no
        // obligation at all — the copy is just an unconsumed fact.
        if (
          event.type === "events.iterate.com/notification/requested" &&
          event.payload.audience.kind === "user" &&
          event.payload.audience.userId !== state.birthCertificate?.config.ownerId
        ) {
          return state;
        }
        // An approval or reply intent copied after its claim opens already-
        // presented, so the send pass settles it suppressed.
        const approvalRequestEventOffset = event.payload.approvalRequestEventOffset;
        const pendingApprovalPresentations = { ...state.pendingApprovalPresentations };
        const approvalPresentedAt = !Number.isFinite(approvalRequestEventOffset)
          ? undefined
          : pendingApprovalPresentations[String(approvalRequestEventOffset)];
        if (Number.isFinite(approvalRequestEventOffset)) {
          delete pendingApprovalPresentations[String(approvalRequestEventOffset)];
        }
        const replyOffset = event.payload.agentReplyEventOffset;
        const destination = event.payload.destination;
        const claimed =
          Number.isFinite(replyOffset) && destination.kind === "agent-chat"
            ? state.recentReplyClaims.find(
                (claim) =>
                  claim.path === destination.path && claim.replyEventOffset === replyOffset,
              )
            : undefined;
        return {
          ...state,
          latestApprovalRequestEventOffset: !Number.isFinite(approvalRequestEventOffset)
            ? state.latestApprovalRequestEventOffset
            : Math.max(state.latestApprovalRequestEventOffset, approvalRequestEventOffset),
          pendingApprovalPresentations,
          notifications: {
            ...state.notifications,
            [event.offset]: {
              ...(!Number.isFinite(event.payload.agentReplyEventOffset)
                ? {}
                : { agentReplyEventOffset: event.payload.agentReplyEventOffset }),
              ...(!Number.isFinite(approvalRequestEventOffset)
                ? {}
                : { approvalRequestEventOffset }),
              ...((approvalPresentedAt || claimed?.claimedAt) && {
                presentedAt: approvalPresentedAt || claimed?.claimedAt,
              }),
              body: event.payload.body,
              destination: event.payload.destination,
              expiresAt: event.payload.expiresAt,
              requestedAt: Date.parse(event.createdAt),
              title: event.payload.title,
              status: "requested" as const,
            },
          },
        };
      }
      case "events.iterate.com/project/approval-presented": {
        // The claim marks every still-`requested` obligation for the batch;
        // the send pass settles them `suppressed`. The ordered copy lane may
        // carry the claim before the notification processor's later intent,
        // so a claim above the intent high-water mark waits durably for that
        // intent. A claim at or below the frontier matching no requested
        // obligation is late (already sent or settled) and remains a no-op.
        const claimed = Object.entries(state.notifications).filter(
          ([, notification]) =>
            notification.status === "requested" &&
            notification.approvalRequestEventOffset === event.payload.approvalRequestEventOffset &&
            !Number.isFinite(notification.presentedAt),
        );
        if (claimed.length) {
          const notifications = { ...state.notifications };
          for (const [offset, notification] of claimed) {
            notifications[offset] = { ...notification, presentedAt: Date.parse(event.createdAt) };
          }
          return { ...state, notifications };
        }
        if (event.payload.approvalRequestEventOffset <= state.latestApprovalRequestEventOffset) {
          return state;
        }
        return {
          ...state,
          pendingApprovalPresentations: {
            ...state.pendingApprovalPresentations,
            [event.payload.approvalRequestEventOffset]: Date.parse(event.createdAt),
          },
        };
      }
      case "events.iterate.com/project/agent-reply-presented": {
        // Same shape as the approval claim, matched on the (destination
        // path, reply offset) pair — AND remembered, so an intent the
        // subscription copies after this claim still opens pre-claimed (the
        // claim-before-intent race is real for replies; see the module doc).
        const claimedAt = Date.parse(event.createdAt);
        const recentReplyClaims = [
          ...state.recentReplyClaims.filter(
            (claim) =>
              claim.claimedAt > claimedAt - RECENT_REPLY_CLAIM_RETENTION_MS &&
              !(
                claim.path === event.payload.path &&
                claim.replyEventOffset === event.payload.replyEventOffset
              ),
          ),
          {
            claimedAt,
            path: event.payload.path,
            replyEventOffset: event.payload.replyEventOffset,
          },
        ].slice(-RECENT_REPLY_CLAIM_LIMIT);
        const claimed = Object.entries(state.notifications).filter(
          ([, notification]) =>
            notification.status === "requested" &&
            notification.agentReplyEventOffset === event.payload.replyEventOffset &&
            notification.destination.kind === "agent-chat" &&
            notification.destination.path === event.payload.path &&
            !Number.isFinite(notification.presentedAt),
        );
        if (!claimed.length) return { ...state, recentReplyClaims };
        const notifications = { ...state.notifications };
        for (const [offset, notification] of claimed) {
          notifications[offset] = { ...notification, presentedAt: claimedAt };
        }
        return { ...state, notifications, recentReplyClaims };
      }
      case "events.iterate.com/device/notification-attempt-started": {
        const notification = state.notifications[event.payload.requestOffset];
        if (!notification) return state;
        return {
          ...state,
          notifications: {
            ...state.notifications,
            [event.payload.requestOffset]: { ...notification, status: "started" as const },
          },
        };
      }
      case "events.iterate.com/device/notification-ticket-observed": {
        const notification = state.notifications[event.payload.requestOffset];
        if (!notification) return state;
        return {
          ...state,
          notifications: {
            ...state.notifications,
            [event.payload.requestOffset]: {
              ...notification,
              status: "ticketed" as const,
              ticketId: event.payload.ticketId,
              ticketObservedAt: Date.parse(event.createdAt),
            },
          },
        };
      }
      case "events.iterate.com/device/notification-settled": {
        // Terminal: the obligation leaves the state entirely.
        const notifications = { ...state.notifications };
        delete notifications[event.payload.requestOffset];
        return { ...state, notifications };
      }
      case "events.iterate.com/device/notification-opened":
        return { ...state, lastNotificationOpenedAt: event.payload.openedAt };
      default:
        return state;
    }
  }

  /**
   * Poll Expo receipts for every ticketed obligation whose check is due —
   * called by the device Durable Object's alarm with the current state, never
   * from delivery. An accepted/rejected receipt settles the obligation
   * (DeviceNotRegistered additionally compare-and-clears the push-token Secret
   * and, if the clear won, revokes the device); a pending receipt re-arms the
   * alarm; past the retention window the outcome settles uncertain. Errors
   * propagate to the DO, which re-arms a retry alarm.
   */
  async checkReceipts(state: DeviceProcessorState): Promise<void> {
    const now = this.deps.now();
    const settlements: { requestOffset: number; outcome: DeviceNotificationOutcome }[] = [];
    let pushTokenInvalid = false;
    let nextCheckAt: number | null = null;
    for (const [offset, notification] of Object.entries(state.notifications)) {
      if (
        notification.status !== "ticketed" ||
        !notification.ticketId ||
        !Number.isFinite(notification.ticketObservedAt)
      ) {
        continue;
      }
      const firstCheckAt = notification.ticketObservedAt + state.config.receiptCheckDelayMs;
      if (now < firstCheckAt) {
        nextCheckAt = !Number.isFinite(nextCheckAt)
          ? firstCheckAt
          : Math.min(nextCheckAt, firstCheckAt);
        continue;
      }
      const receipt = await this.deps.getReceipt(notification.ticketId);
      const requestOffset = Number(offset);
      if (receipt.status === "accepted-by-push-service") {
        settlements.push({
          requestOffset,
          outcome: { kind: "accepted-by-push-service", ticketId: notification.ticketId },
        });
      } else if (receipt.status === "rejected-by-push-service") {
        pushTokenInvalid ||= receipt.error === "DeviceNotRegistered";
        settlements.push({
          requestOffset,
          outcome: {
            kind: "rejected-by-push-service",
            error: receipt.error,
            message: receipt.message,
            ticketId: notification.ticketId,
          },
        });
      } else if (now >= notification.ticketObservedAt + state.config.receiptRetentionMs) {
        settlements.push({
          requestOffset,
          outcome: {
            kind: "uncertain",
            phase: "receipt",
            reason: "Expo did not produce a push receipt before its 24-hour retention window.",
          },
        });
      } else {
        const retryAt = now + state.config.receiptCheckDelayMs;
        nextCheckAt = !Number.isFinite(nextCheckAt) ? retryAt : Math.min(nextCheckAt, retryAt);
      }
    }
    // The clear is fenced on the credential revision the attempts were made
    // with: a rotation that landed meanwhile makes it a no-op, and only a
    // WINNING clear may revoke the device.
    const pushTokenInvalidated =
      pushTokenInvalid && state.pushTokenSecret
        ? await this.deps.clearPushToken({
            pushTokenSecretPath: state.pushTokenSecret.path,
            pushTokenSecretUpdatedOffset: state.pushTokenSecret.updatedOffset,
          })
        : false;
    if (pushTokenInvalidated) {
      await this.append({
        type: "events.iterate.com/device/revoked",
        idempotencyKey: this.idempotencyKey("push-token-invalid"),
        payload: { reason: "push-token-invalid" },
      });
    }
    if (settlements.length) {
      await this.#appendUnlessLostIdempotencyRace(
        (...events) => this.append(...events),
        settlements.map(({ outcome, requestOffset }) => ({
          type: "events.iterate.com/device/notification-settled" as const,
          idempotencyKey: this.idempotencyKey(`notification-settled@${requestOffset}`),
          payload: { requestOffset, outcome },
        })),
      );
    }
    await this.deps.repointReceiptAlarm(nextCheckAt);
  }

  /**
   * Send every claimable obligation (approval batch or chat reply) whose
   * grace window elapsed unclaimed —
   * called by the device Durable Object's grace alarm, never from delivery: a
   * grace expiry appends NO event, so no delivery pass would otherwise run
   * the send. The rules mirror the at-head pass exactly: claimed obligations
   * are skipped (the delivery pass that reduced the claim settles them
   * `suppressed`), an expired one settles expired, a missing credential waits
   * for the at-head device-unavailable sweep, the live-set guards against
   * double dials, and obligations still inside grace re-arm the alarm.
   * Errors propagate to the DO, which re-arms a retry alarm.
   *
   * `readState` (not a snapshot): the sends await network, and deliveries
   * interleave with those awaits — a newer intent can open (and arm the
   * slice for) an in-grace obligation an entry snapshot never saw, and the
   * final repoint below would wipe that arm with `null`, stranding the push
   * (no event ever comes to recover a lapsed grace). Deriving the re-arm
   * from CURRENT state after the sends closes that window.
   * `checkReceipts`' final repoint has the same theoretical exposure, but at
   * worst it delays a receipt POLL (each poll re-arms and the retention
   * sweep still bounds it) — never a user-facing push — so it keeps its
   * simpler snapshot shape.
   */
  async releaseGraces(readState: () => DeviceProcessorState): Promise<void> {
    const state = readState();
    const now = this.deps.now();
    for (const [offset, notification] of Object.entries(state.notifications)) {
      const graceUntil = obligationGraceUntil(notification, state.config);
      if (
        notification.status !== "requested" ||
        graceUntil === 0 ||
        Number.isFinite(notification.presentedAt) ||
        now < graceUntil
      ) {
        continue;
      }
      const requestOffset = Number(offset);
      if (notification.expiresAt <= now) {
        await this.#appendUnlessLostIdempotencyRace(
          (...events) => this.append(...events),
          [
            {
              type: "events.iterate.com/device/notification-settled",
              idempotencyKey: this.idempotencyKey(`notification-settled@${requestOffset}`),
              payload: { requestOffset, outcome: { kind: "expired" } },
            },
          ],
        );
        continue;
      }
      if (!state.pushTokenSecret || !this.projectId || this.#liveSendAttempts.has(requestOffset)) {
        continue;
      }
      this.#liveSendAttempts.add(requestOffset);
      await this.#sendNotification({
        notification,
        pushTokenSecretPath: state.pushTokenSecret.path,
        pushTokenSecretUpdatedOffset: state.pushTokenSecret.updatedOffset,
        requestOffset,
      });
    }
    await this.deps.repointGraceAlarm(this.#nextGraceExpiry(readState()));
  }

  /**
   * The earliest pending grace expiry among unclaimed claimable obligations
   * still inside their window, or null when none — what the grace alarm
   * slice points at. One derivation shared by the at-head pass and
   * releaseGraces, so the alarm can never disagree with the send
   * gate about what is owed.
   */
  #nextGraceExpiry(state: DeviceProcessorState): number | null {
    const now = this.deps.now();
    return Object.values(state.notifications)
      .filter(
        (notification) =>
          notification.status === "requested" && !Number.isFinite(notification.presentedAt),
      )
      .reduce<number | null>((earliest, notification) => {
        const at = obligationGraceUntil(notification, state.config);
        if (at <= now) return earliest;
        return !Number.isFinite(earliest) || at < earliest ? at : earliest;
      }, null);
  }

  /**
   * One send attempt: durable attempt-started evidence FIRST (if that append
   * fails, the body never runs and the obligation stays `requested` for a
   * later pass), then the Expo dial, then the outcome — a receipt ticket, or
   * a rejection settled immediately (DeviceNotRegistered compare-and-clears
   * the credential and, if the clear won, revokes the device). The live-set
   * entry is released in `finally` either way, or this incarnation would skip
   * the requestOffset forever.
   */
  async #sendNotification(input: {
    notification: DeviceProcessorState["notifications"][string];
    pushTokenSecretPath: string;
    pushTokenSecretUpdatedOffset: number;
    requestOffset: number;
  }) {
    try {
      await this.append({
        type: "events.iterate.com/device/notification-attempt-started",
        idempotencyKey: this.idempotencyKey(`notification-attempt-started@${input.requestOffset}`),
        payload: { requestOffset: input.requestOffset },
      });
      const sendAttempt = this.deps.send({
        notification: {
          body: input.notification.body,
          data: {
            destination: input.notification.destination,
            projectId: this.projectId!,
            requestOffset: input.requestOffset,
          },
          expiresAt: input.notification.expiresAt,
          title: input.notification.title,
        },
        pushTokenSecretPath: input.pushTokenSecretPath,
        pushTokenSecretUpdatedOffset: input.pushTokenSecretUpdatedOffset,
      });
      const observedSend: Promise<
        | { status: "fulfilled"; ticket: Awaited<ReturnType<DevicePushSender>> }
        | { status: "rejected"; error: unknown }
      > = sendAttempt.then(
        (ticket) => ({ status: "fulfilled" as const, ticket }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      let sendDeadline: ReturnType<typeof setTimeout> | undefined;
      const sendOutcome = await Promise.race([
        observedSend,
        new Promise<{ status: "deadline" }>((resolve) => {
          sendDeadline = setTimeout(() => resolve({ status: "deadline" }), this.deps.sendTimeoutMs);
        }),
      ]).finally(() => clearTimeout(sendDeadline));
      if (sendOutcome.status !== "fulfilled") {
        let detail: string;
        if (sendOutcome.status === "deadline") {
          detail = `the ${this.deps.sendTimeoutMs}ms deadline elapsed`;
        } else if (sendOutcome.error instanceof Error) {
          detail = sendOutcome.error.message;
        } else {
          detail = String(sendOutcome.error);
        }
        await this.#appendUnlessLostIdempotencyRace(
          (...events) => this.append(...events),
          [
            {
              type: "events.iterate.com/device/notification-settled",
              idempotencyKey: this.idempotencyKey(`notification-settled@${input.requestOffset}`),
              payload: {
                requestOffset: input.requestOffset,
                outcome: {
                  kind: "uncertain",
                  phase: "expo-send",
                  reason:
                    `The Expo send did not produce a ticket after the durable attempt began: ` +
                    `${detail.slice(0, 500)}. The vendor may have accepted the push, so it was not retried.`,
                },
              },
            },
          ],
        );
        return;
      }
      const ticket = sendOutcome.ticket;
      if (ticket.status === "error") {
        const pushTokenInvalidated =
          ticket.error === "DeviceNotRegistered"
            ? await this.deps.clearPushToken({
                pushTokenSecretPath: input.pushTokenSecretPath,
                pushTokenSecretUpdatedOffset: input.pushTokenSecretUpdatedOffset,
              })
            : false;
        if (pushTokenInvalidated) {
          await this.append({
            type: "events.iterate.com/device/revoked",
            idempotencyKey: this.idempotencyKey("push-token-invalid"),
            payload: { reason: "push-token-invalid" },
          });
        }
        await this.#appendUnlessLostIdempotencyRace(
          (...events) => this.append(...events),
          [
            {
              type: "events.iterate.com/device/notification-settled",
              idempotencyKey: this.idempotencyKey(`notification-settled@${input.requestOffset}`),
              payload: {
                requestOffset: input.requestOffset,
                outcome: {
                  kind: "rejected-by-expo",
                  error: ticket.error,
                  message: ticket.message,
                },
              },
            },
          ],
        );
        return;
      }
      await this.append({
        type: "events.iterate.com/device/notification-ticket-observed",
        idempotencyKey: this.idempotencyKey(`notification-ticket-observed@${input.requestOffset}`),
        payload: { requestOffset: input.requestOffset, ticketId: ticket.ticketId },
      });
    } finally {
      this.#liveSendAttempts.delete(input.requestOffset);
    }
  }

  /**
   * Append settlements whose idempotency keys may race concurrent writers:
   * every writer of `notification-settled@<offset>` (expiry sweep, send
   * rejection, receipt check) races every other. The stream rejects a
   * same-key append with a different body; the FIRST writer's settlement
   * stands, and losing the race is success — the obligation is settled
   * either way. One event per append, NOT one batch: each requestOffset
   * races independently, and a batch is atomic — one lost race would
   * silently drop every sibling settlement in it.
   */
  async #appendUnlessLostIdempotencyRace(
    append: ProcessEventArgs<DeviceProcessorContract>["append"],
    events: EmittedInput<DeviceProcessorContract>[],
  ): Promise<void> {
    for (const event of events) {
      try {
        await append(event);
      } catch (error) {
        if (!isIdempotencyConflict(error)) throw error;
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Injected dependencies.
// -----------------------------------------------------------------------------

/** What one Expo push carries; `data` is what the app receives on tap. */
export type DevicePushMessage = {
  body: string;
  data: {
    destination: DeviceProcessorState["notifications"][string]["destination"];
    projectId: string;
    requestOffset: number;
  };
  expiresAt: number;
  title: string;
};

/**
 * The injected Expo send transport — the processor's only send-side vendor
 * surface, so tests swap in a scripted fake. The Secret coordinates ride
 * along because the REAL sender substitutes the token material at the egress
 * door, fenced on the credential revision.
 */
export type DevicePushSender = (input: {
  notification: DevicePushMessage;
  pushTokenSecretPath: string;
  pushTokenSecretUpdatedOffset: number;
}) => Promise<
  { status: "ok"; ticketId: string } | { status: "error"; error: string; message: string }
>;

/** Expo's receipt answer for one ticket. */
type DevicePushReceipt =
  | { status: "pending" }
  | { status: "accepted-by-push-service" }
  | { status: "rejected-by-push-service"; error: string; message: string };

type DeviceProcessorDeps = {
  /**
   * Compare-and-clear the push-token Secret's material at the given update
   * offset; answers whether THIS clear destroyed it (false = a rotation won).
   */
  clearPushToken: (input: {
    pushTokenSecretPath: string;
    pushTokenSecretUpdatedOffset: number;
  }) => Promise<boolean>;
  /** Poll Expo's receipt API for one ticket. */
  getReceipt: (ticketId: string) => Promise<DevicePushReceipt>;
  /** Injectable clock — virtual time in tests, real time in the DO. */
  now: () => number;
  /** Point the DO's grace alarm slice at an epoch ms, or disarm with null. */
  repointGraceAlarm: (atMs: number | null) => Promise<void>;
  /** Point the DO's receipt alarm slice at an epoch ms, or disarm with null. */
  repointReceiptAlarm: (atMs: number | null) => Promise<void>;
  /** Bound one vendor attempt so a live incarnation cannot strand it forever. */
  sendTimeoutMs: number;
  send: DevicePushSender;
};

// -----------------------------------------------------------------------------
// Pure helpers.
// -----------------------------------------------------------------------------

/** How long a reduced reply claim stays matchable against a late-copied
 * intent. Generous next to the grace window — retention costs a few state
 * bytes, and a claim older than this can only mean the intent never came. */
const RECENT_REPLY_CLAIM_RETENTION_MS = 10 * 60_000;

/** Hard cap on remembered reply claims, so a claim-spamming client cannot
 * grow the state without bound inside the retention window. */
const RECENT_REPLY_CLAIM_LIMIT = 50;

/**
 * When an obligation's send attempt may start: `requestedAt` plus its grace
 * window for claimable obligations (approval batches, chat replies), or 0 —
 * no wait — for plain notifications. One derivation shared by the at-head
 * send gate, the grace alarm, and releaseGraces.
 */
function obligationGraceUntil(
  notification: DeviceProcessorState["notifications"][string],
  config: DeviceProcessorState["config"],
): number {
  if (Number.isFinite(notification.approvalRequestEventOffset)) {
    return notification.requestedAt + config.approvalGraceMs;
  }
  if (Number.isFinite(notification.agentReplyEventOffset)) {
    return notification.requestedAt + config.replyGraceMs;
  }
  return 0;
}

/**
 * The notification-intent subscription on the project root stream: sends
 * every project-level `notification/requested` intent — and every
 * `project/approval-presented` / `project/agent-reply-presented` suppression
 * claim, which must chase the
 * intents it cancels down the same ordered lane — onto this device's stream,
 * where they reduce into push obligations and claim marks. Keyed per device
 * path, so created/updated re-arms converge on one rule.
 */
function notificationIntentSubscriptionEvent(input: { idempotencyKey: string; path: string }) {
  return {
    type: "events.iterate.com/stream/subscription-configured" as const,
    idempotencyKey: input.idempotencyKey,
    payload: {
      name: `notification-intent:${input.path}`,
      description: `Delivers project notification intents to ${input.path} for device-owned delivery.`,
      filter: {
        eventTypes: [
          "events.iterate.com/notification/requested",
          "events.iterate.com/project/approval-presented",
          "events.iterate.com/project/agent-reply-presented",
        ],
      },
      receiver: {
        action: "copy-to-stream" as const,
        receivingStreamPath: input.path,
        delivery: {
          start: "now" as const,
          onFailingEvent: "halt" as const,
        },
      },
    },
  };
}
