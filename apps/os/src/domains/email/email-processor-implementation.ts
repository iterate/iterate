import { StreamProcessor } from "iterate/processors";
import type { EmittedInput, ProcessEventArgs, ReduceArgs } from "iterate/processors";
import {
  agentCreationForPath,
  EMAIL_AGENT_SYSTEM_PROMPT,
  EMAIL_AGENT_SYSTEM_PROMPT_REVISION,
} from "../agents/agent-defaults.ts";
import { normalizeAgentBindingLabel } from "../agents/agent-presence.ts";
import { EmailAgentProcessorContract } from "./email-agent-processor-contract.ts";
import {
  EmailProcessorContract,
  type EmailProcessorState,
  type InboundEmailPayload,
} from "./email-processor-contract.ts";
import { emailAgentPath, emailCounterpart, normalizeMessageId } from "./utils.ts";

/**
 * The email thread router, mounted on the per-project `/integrations/email`
 * stream. Emitted event types, payloads, and idempotency keys are stable wire
 * formats.
 *
 * HOW IT WORKS, end to end:
 *
 * The worker's `email()` handler (email-ingress.ts) authenticates inbound
 * mail, parses the MIME, stores attachment bytes into project file storage,
 * and appends one `email/received` event here. This processor resolves which
 * email thread the mail belongs to — the recipient's `+t<threadId>` tag
 * first, then In-Reply-To/References against the reduced message-id index,
 * else a NEW thread whose id is the received event's own offset — and
 * forwards the received event unchanged to the thread's agent stream
 * (`/agents/email/t<threadId>`).
 *
 * For a new thread the forward and the thread's whole creation ride ONE
 * batch onto the routed stream: the Agent + CapabilityHost birth pair, the
 * email facet's `email-agent/created` certificate, the system prompt, the
 * thread's binding, and all subscriptions — then the route context and the
 * mail itself. Every event in that batch is idempotency-keyed and
 * deterministic, so an at-least-once redelivery re-appends identical bodies
 * that dedupe instead of duplicating a thread. The route is also recorded
 * on THIS stream as `email/thread-route-configured`, which is what `reduce`
 * merges into the routing table.
 *
 * Outbound mail is indexed too: `email/sent` audit events carrying a
 * `threadId` reduce their messageId into the same index, so replies to what
 * the agent sent route back to the thread even without the `+t` tag.
 * Agent-initiated conversations (agent-scoped itx.email.send) append a route
 * whose streamPath is the calling agent's OWN path, so their replies forward
 * straight to that agent instead of minting an `/agents/email/**` stream.
 *
 * Both forwards run under `blockProcessorWhile`: the forward is the only
 * copy of the email on its way to the agent (a fire-and-forget append once
 * lost a message for good), so a failed append holds the checkpoint and the
 * redelivered frame retries into the idempotency keys.
 */
export class EmailProcessor extends StreamProcessor<EmailProcessorContract> {
  readonly contract = EmailProcessorContract;

  // ------------------------------------------------------------ processEvent
  protected override processEvent(args: ProcessEventArgs<EmailProcessorContract>): undefined {
    const { event, previousState, state, append, appendTo, blockProcessorWhile } = args;

    switch (event?.type) {
      case "events.iterate.com/email/received": {
        // Project creation owns the router's birth; no mail routes before it.
        if (!state.birthCertificate) return;

        // Resolve against the state BEFORE this event — the same input
        // reduce() consumed — so the forward target and the reduced routing
        // table can never disagree.
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
          // Same reply-target chain as everywhere else (emailCounterpart), so
          // the durable route event never disagrees with the agent's reply
          // door.
          const counterpart = emailCounterpart(event.payload);
          const routeEvent = {
            type: "events.iterate.com/email/thread-route-configured" as const,
            idempotencyKey: `email-route:${resolution.threadId}`,
            payload: {
              threadId: resolution.threadId,
              streamPath: resolution.streamPath,
              ...(counterpart && { counterpart }),
              ...(event.payload.message.subject && { subject: event.payload.message.subject }),
            },
          };
          blockProcessorWhile(async () => {
            await append(routeEvent);
            if (!this.projectId) {
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

        blockProcessorWhile(async () => {
          await appendTo(resolution.streamPath, forwardedEvent);
        });
        return;
      }
      // email/created, email/sender-allowed, email/sent, and
      // email/thread-route-configured are reduce-only facts, and the router
      // has no event-less at-head work.
    }
  }

  // ------------------------------------------------------------------ reduce
  // Pure reduction, one switch, cases inline.
  protected override reduce({
    event,
    state,
  }: ReduceArgs<EmailProcessorContract>): EmailProcessorState {
    switch (event.type) {
      case "events.iterate.com/email/created":
        if (state.birthCertificate) return state;
        return { ...state, birthCertificate: event.payload };
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
          threadByMessageId: messageId
            ? { ...state.threadByMessageId, [messageId]: resolution.threadId }
            : state.threadByMessageId,
        };
      }
      case "events.iterate.com/email/sender-allowed": {
        const pattern = event.payload.pattern.trim().toLowerCase();
        if (!pattern.length || state.allowedSenders.includes(pattern)) return state;
        return { ...state, allowedSenders: [...state.allowedSenders, pattern] };
      }
      case "events.iterate.com/email/sent": {
        // Outbound mail sent inside a thread: index its messageId so replies
        // to the agent's own messages route back without the +t tag.
        const threadId = event.payload.threadId;
        const messageId = normalizeMessageId(event.payload.messageId);
        if (!threadId || !messageId) return state;
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
}

// -----------------------------------------------------------------------------
// Pure helpers.
// -----------------------------------------------------------------------------

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
 * Shared by `reduce` (indexing) and `processEvent` (forwarding), so the
 * reduced routing table and the forward can never disagree.
 */
function resolveEmailThread(input: {
  offset: number;
  payload: InboundEmailPayload;
  state: EmailProcessorState;
}): EmailThreadResolution {
  const { offset, payload, state } = input;

  const tagged = payload.recipient.threadId;
  if (tagged) {
    const streamPath = state.threads[tagged];
    if (streamPath) return { isNew: false, streamPath, threadId: tagged };
  }

  const headerIds = [payload.message.inReplyTo, ...payload.message.references]
    .map((id) => normalizeMessageId(id))
    .filter((id): id is string => !!id);
  for (const id of headerIds) {
    const threadId = state.threadByMessageId[id];
    const streamPath = threadId ? state.threads[threadId] : undefined;
    if (threadId && streamPath) {
      return { isNew: false, streamPath, threadId };
    }
  }

  const threadId = String(offset);
  return { isNew: true, streamPath: emailAgentPath(threadId), threadId };
}

/**
 * The creation batch for one new email thread stream: the standard
 * Agent + CapabilityHost pair (agentCreationForPath) with the email facet as
 * the named sibling, the thread's binding among the initial events, and the
 * email system prompt. Every event is idempotency-keyed and deterministic —
 * a redelivered forward re-appends identical bodies that dedupe.
 */
function emailAgentCreationEvents(input: {
  counterpart?: string;
  path: string;
  projectId: string;
  subject?: string;
  threadId: string;
}): EmittedInput<EmailProcessorContract>[] {
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
          ...(subject && { subject }),
          ...(counterpart && { counterpart }),
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
            ...(input.counterpart && { counterpart: input.counterpart }),
            ...(input.subject && { subject: input.subject }),
          },
        },
      }),
      name: EmailAgentProcessorContract.slug,
    },
  });
  return creation.events satisfies EmittedInput<EmailProcessorContract>[];
}
