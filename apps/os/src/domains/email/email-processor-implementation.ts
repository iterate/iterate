// Implements the "email" thread-router processor on itx, shaped after the
// Slack webhook router (slack-processor-implementation.ts). Emitted event
// types, payloads, and idempotency keys are stable wire formats.

import type { z } from "zod";
import { StreamProcessor, type EmittedInput } from "iterate/processors";
import {
  agentCreationForPath,
  EMAIL_AGENT_SYSTEM_PROMPT,
  EMAIL_AGENT_SYSTEM_PROMPT_REVISION,
} from "../agents/agent-defaults.ts";
import { normalizeAgentBindingLabel } from "../agents/agent-presence.ts";
import type { NotificationDestination } from "../notifications/types.ts";
import { EmailAgentProcessorContract } from "./email-agent-processor-contract.ts";
import {
  EmailProcessorContract,
  type EmailProcessorState,
  type InboundEmailPayload,
} from "./email-processor-contract.ts";
import { emailAgentPath, emailCounterpart, normalizeMessageId } from "./utils.ts";

/** Where one inbound email belongs: an existing thread or a brand-new one. */
type EmailThreadResolution = {
  isNew: boolean;
  streamPath: string;
  threadId: string;
};

/**
 * Resolve the thread for one received email against router state, in fallback
 * order:
 *
 * 1. The recipient's `+t<threadId>` tag, when it names a thread we know. An
 *    unknown tag falls through — it routes by headers or starts a new thread
 *    instead of minting an attacker-chosen thread id.
 * 2. In-Reply-To, then References, against the message-id index. This catches
 *    replies sent to the bare project address.
 * 3. A new thread whose id is the received event's offset on
 *    `/integrations/email` — deterministic, unique per project, replay-safe.
 *
 * Shared by `reduce` (folding the index) and `processEvent` (forwarding), so
 * the fold and the forward can never disagree.
 */
function resolveEmailThread(input: {
  offset: number;
  payload: InboundEmailPayload;
  state: EmailProcessorState;
}): EmailThreadResolution {
  const { offset, payload, state } = input;

  const tagged = payload.recipient.threadId;
  if (tagged !== null) {
    const streamPath = state.threads[tagged];
    if (streamPath !== undefined) return { isNew: false, streamPath, threadId: tagged };
  }

  const headerIds = [payload.message.inReplyTo, ...payload.message.references]
    .map((id) => normalizeMessageId(id))
    .filter((id): id is string => id !== null);
  for (const id of headerIds) {
    const threadId = state.threadByMessageId[id];
    const streamPath = threadId === undefined ? undefined : state.threads[threadId];
    if (threadId !== undefined && streamPath !== undefined) {
      return { isNew: false, streamPath, threadId };
    }
  }

  const threadId = String(offset);
  return { isNew: true, streamPath: emailAgentPath(threadId), threadId };
}

export class EmailProcessor extends StreamProcessor<
  typeof EmailProcessorContract,
  {
    now: () => number;
    sendNotification: (input: {
      notification: {
        body: string;
        destination: z.output<typeof NotificationDestination>;
        title: string;
      };
      to: string;
    }) => Promise<{ from: string; messageId: string | null }>;
  }
> {
  readonly contract = EmailProcessorContract;
  readonly #liveNotificationAttempts = new Set<number>();

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof EmailProcessorContract>["reduce"]>[0]): EmailProcessorState {
    switch (event.type) {
      case "events.iterate.com/email/created":
        if (state.birthCertificate !== null) {
          throw new Error("Email processor received more than one email/created event");
        }
        return {
          ...state,
          birthCertificate: event.payload,
          notificationRecipients:
            event.payload.config.notificationRecipient === undefined
              ? state.notificationRecipients
              : [event.payload.config.notificationRecipient.toLowerCase()],
        };
      case "events.iterate.com/email/received": {
        const resolution = resolveEmailThread({
          offset: event.offset,
          payload: event.payload,
          state,
        });
        const messageId = normalizeMessageId(event.payload.message.messageId);
        return {
          ...state,
          threads: { ...state.threads, [resolution.threadId]: resolution.streamPath },
          threadByMessageId:
            messageId === null
              ? state.threadByMessageId
              : { ...state.threadByMessageId, [messageId]: resolution.threadId },
        };
      }
      case "events.iterate.com/email/sender-allowed": {
        const pattern = event.payload.pattern.trim().toLowerCase();
        if (pattern.length === 0 || state.allowedSenders.includes(pattern)) return state;
        return { ...state, allowedSenders: [...state.allowedSenders, pattern] };
      }
      case "events.iterate.com/email/notification-recipient-configured": {
        const email = event.payload.email.toLowerCase();
        if (state.notificationRecipients.includes(email)) return state;
        return { ...state, notificationRecipients: [...state.notificationRecipients, email] };
      }
      case "events.iterate.com/notification/requested":
        return {
          ...state,
          notifications: {
            ...state.notifications,
            [event.offset]: { ...event.payload, status: "requested" as const },
          },
        };
      case "events.iterate.com/email/notification-attempt-started": {
        const notification = state.notifications[event.payload.requestOffset];
        if (notification === undefined) return state;
        return {
          ...state,
          notifications: {
            ...state.notifications,
            [event.payload.requestOffset]: { ...notification, status: "started" as const },
          },
        };
      }
      case "events.iterate.com/email/notification-settled": {
        const notifications = { ...state.notifications };
        delete notifications[event.payload.requestOffset];
        return { ...state, notifications };
      }
      case "events.iterate.com/email/sent": {
        // Outbound mail sent inside a thread: index its messageId so replies
        // to the agent's own messages route back without the +t tag.
        const threadId = event.payload.threadId;
        const messageId = normalizeMessageId(event.payload.messageId);
        if (threadId === undefined || messageId === null) return state;
        return {
          ...state,
          threadByMessageId: { ...state.threadByMessageId, [messageId]: threadId },
        };
      }
      case "events.iterate.com/email/thread-route-configured":
        return {
          ...state,
          threads: { ...state.threads, [event.payload.threadId]: event.payload.streamPath },
        };
      default:
        return state;
    }
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<typeof EmailProcessorContract>["processEvent"]>[0],
  ): undefined {
    const { append, appendTo, blockProcessorWhile, event, previousState, state } = args;
    if (state.birthCertificate === null) return;
    if (
      event?.type === "events.iterate.com/email/created" ||
      event?.type === "events.iterate.com/email/notification-recipient-configured"
    ) {
      blockProcessorWhile(() =>
        appendTo(
          "/",
          emailNotificationIntentCrossPost({ path: this.path, projectId: this.projectId }),
        ),
      );
    }
    if (args.delivery.caughtUp) this.#reconcileNotifications(args);
    if (event === null || event.type === "events.iterate.com/email/created") return;
    if (event.type !== "events.iterate.com/email/received") return;

    // Resolve against the state BEFORE this event — the same input reduce()
    // folded — so forward target and fold always agree.
    const resolution = resolveEmailThread({
      offset: event.offset,
      payload: event.payload,
      state: previousState,
    });

    const forwardedEvent = {
      type: "events.iterate.com/email/received" as const,
      idempotencyKey: this.idempotencyKey("forward-received", event),
      payload: event.payload,
    };

    if (resolution.isNew) {
      // Same reply-target chain as everywhere else (emailCounterpart), so the
      // durable route event never disagrees with the agent's reply door.
      const counterpart = emailCounterpart(event.payload);
      const routeEvent = {
        type: "events.iterate.com/email/thread-route-configured" as const,
        idempotencyKey: `email-route:${resolution.threadId}`,
        payload: {
          threadId: resolution.threadId,
          streamPath: resolution.streamPath,
          ...(counterpart === null ? {} : { counterpart }),
          ...(event.payload.message.subject === undefined
            ? {}
            : { subject: event.payload.message.subject }),
        },
      };
      // Durable obligation, NOT best-effort: this forward is the only copy of
      // the email on its way to the agent (same reasoning as the Slack
      // router's forward — a fire-and-forget append once lost a message for
      // good). blockProcessorWhile holds the checkpoint so a failed append
      // replays; idempotency keys make the replay dedupe.
      blockProcessorWhile(async () => {
        await append(routeEvent);
        if (this.projectId === null) {
          throw new Error("Email router cannot create a project agent without a project id");
        }
        await appendTo(
          resolution.streamPath,
          ...emailAgentCreationEvents({
            counterpart: counterpart ?? undefined,
            path: resolution.streamPath,
            projectId: this.projectId,
            subject: event.payload.message.subject,
            threadId: resolution.threadId,
          }),
          routeEvent,
          forwardedEvent,
        );
      });
      return;
    }

    // Durable obligation — same reasoning as the route-creation forward above.
    blockProcessorWhile(async () => {
      await appendTo(resolution.streamPath, forwardedEvent);
    });
  }

  #reconcileNotifications(
    args: Parameters<StreamProcessor<typeof EmailProcessorContract>["processEvent"]>[0],
  ) {
    const recipient = args.state.notificationRecipients[0];
    const settlements: {
      requestOffset: number;
      outcome:
        | { kind: "expired" }
        | { kind: "recipient-unavailable" }
        | { kind: "uncertain"; reason: string };
    }[] = [];
    for (const [offset, notification] of Object.entries(args.state.notifications)) {
      const requestOffset = Number(offset);
      if (notification.status === "requested" && notification.expiresAt <= this.deps.now()) {
        settlements.push({ requestOffset, outcome: { kind: "expired" } });
      } else if (notification.status === "requested" && recipient === undefined) {
        settlements.push({ requestOffset, outcome: { kind: "recipient-unavailable" } });
      } else if (
        notification.status === "started" &&
        !this.#liveNotificationAttempts.has(requestOffset)
      ) {
        settlements.push({
          requestOffset,
          outcome: {
            kind: "uncertain",
            reason:
              "The processor incarnation disappeared after recording the email attempt; delivery may have succeeded, so it was not retried.",
          },
        });
      }
    }
    if (settlements.length > 0) {
      args.blockProcessorWhileCaughtUp(() =>
        this.append(
          ...settlements.map(({ requestOffset, outcome }) => ({
            type: "events.iterate.com/email/notification-settled" as const,
            idempotencyKey: this.idempotencyKey(`notification-settled@${requestOffset}`),
            payload: { requestOffset, outcome },
          })),
        ),
      );
    }
    if (recipient === undefined) return;
    for (const [offset, notification] of Object.entries(args.state.notifications)) {
      const requestOffset = Number(offset);
      if (
        notification.status !== "requested" ||
        notification.expiresAt <= this.deps.now() ||
        this.#liveNotificationAttempts.has(requestOffset)
      ) {
        continue;
      }
      this.#liveNotificationAttempts.add(requestOffset);
      args.runInBackground(() =>
        this.#sendNotification({ notification, recipient, requestOffset }),
      );
    }
  }

  async #sendNotification(input: {
    notification: EmailProcessorState["notifications"][string];
    recipient: string;
    requestOffset: number;
  }) {
    const projectId = this.projectId;
    if (projectId === null) {
      this.#liveNotificationAttempts.delete(input.requestOffset);
      throw new Error("Email notification delivery requires a project id.");
    }
    try {
      await this.append({
        type: "events.iterate.com/email/notification-attempt-started",
        idempotencyKey: this.idempotencyKey(`notification-attempt-started@${input.requestOffset}`),
        payload: { requestOffset: input.requestOffset },
      });
    } catch (error) {
      // No vendor call happened, so clearing the in-memory guard allows an
      // ordinary later delivery to retry the journal append safely.
      this.#liveNotificationAttempts.delete(input.requestOffset);
      throw error;
    }
    try {
      const result = await this.deps.sendNotification({
        notification: {
          body: input.notification.body,
          destination: input.notification.destination,
          title: input.notification.title,
        },
        to: input.recipient,
      });
      await this.append(
        {
          type: "events.iterate.com/email/sent",
          idempotencyKey: this.idempotencyKey(`notification-sent@${input.requestOffset}`),
          payload: {
            from: result.from,
            messageId: result.messageId,
            projectId,
            subject: input.notification.title,
            to: input.recipient,
          },
        },
        {
          type: "events.iterate.com/email/notification-settled",
          idempotencyKey: this.idempotencyKey(`notification-settled@${input.requestOffset}`),
          payload: {
            requestOffset: input.requestOffset,
            outcome: { kind: "sent", messageId: result.messageId },
          },
        },
      );
    } catch (error) {
      await this.append({
        type: "events.iterate.com/email/notification-settled",
        idempotencyKey: this.idempotencyKey(`notification-settled@${input.requestOffset}`),
        payload: {
          requestOffset: input.requestOffset,
          outcome: {
            kind: "uncertain",
            reason: error instanceof Error ? error.message : String(error),
          },
        },
      });
    } finally {
      this.#liveNotificationAttempts.delete(input.requestOffset);
    }
  }
}

function emailNotificationIntentCrossPost(input: { path: string; projectId: string | null }) {
  if (input.projectId === null) {
    throw new Error("Email notification delivery requires a project id.");
  }
  return {
    type: "events.iterate.com/stream/subscription-configured" as const,
    idempotencyKey: `email-notification-intent-cross-post:${input.projectId}`,
    payload: {
      subscriptionKey: `notification-intent:${input.path}`,
      description: `Copies project notification intents to ${input.path} for email-owned delivery.`,
      selector: { eventTypes: ["events.iterate.com/notification/requested"] },
      delivery: {
        mode: "push" as const,
        expression: ["streams", ["get", input.path], "acceptCrossPost"],
      },
      deliver: "new" as const,
    },
  };
}

function emailAgentCreationEvents(input: {
  counterpart?: string;
  path: string;
  projectId: string;
  subject?: string;
  threadId: string;
}): EmittedInput<typeof EmailProcessorContract>[] {
  const subject = normalizeAgentBindingLabel(input.subject);
  const counterpart = normalizeAgentBindingLabel(input.counterpart);
  const creation = agentCreationForPath({
    agentPath: input.path,
    projectId: input.projectId,
    initialEvents: [
      {
        type: "events.iterate.com/agent/binding-set",
        idempotencyKey: `agent/binding:${input.projectId}:${input.path}`,
        payload: {
          type: "email_thread",
          threadId: input.threadId,
          ...(subject === undefined ? {} : { subject }),
          ...(counterpart === undefined ? {} : { counterpart }),
        },
      },
    ],
    systemPromptPolicy: {
      content: EMAIL_AGENT_SYSTEM_PROMPT,
      id: "email",
      revision: EMAIL_AGENT_SYSTEM_PROMPT_REVISION,
    },
    sibling: {
      birthCertificate: EmailAgentProcessorContract.buildEvent({
        type: "events.iterate.com/email-agent/created",
        idempotencyKey: `email-agent/created:${input.projectId}:${input.path}`,
        payload: {
          config: {
            threadId: input.threadId,
            ...(input.counterpart === undefined ? {} : { counterpart: input.counterpart }),
            ...(input.subject === undefined ? {} : { subject: input.subject }),
          },
        },
      }),
      processorSlug: EmailAgentProcessorContract.slug,
    },
  });
  return creation.events satisfies EmittedInput<typeof EmailProcessorContract>[];
}
