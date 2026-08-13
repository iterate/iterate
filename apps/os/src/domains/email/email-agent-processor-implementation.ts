import { stringify as stringifyYaml } from "yaml";
import { isIdempotencyConflict, StreamProcessor } from "iterate/processors";
import type { ProcessEventArgs, ReduceArgs } from "iterate/processors";
import type { AgentFileAttachment } from "../agents/agent-processor-contract.ts";
import { normalizeAgentBindingLabel } from "../agents/agent-presence.ts";
import type { InboundEmailPayload } from "./email-processor-contract.ts";
import { emailCounterpart, isOwnProjectMail } from "./utils.ts";
import {
  EmailAgentProcessorContract,
  type EmailAgentProcessorState,
} from "./email-agent-processor-contract.ts";

/**
 * The email facet on one routed email agent stream
 * (`/agents/email/t<threadId>`). Emitted event types, payloads, and
 * idempotency keys are stable wire formats.
 *
 * HOW IT WORKS, end to end:
 *
 * The email router (email-processor-implementation.ts) creates this stream
 * when a new thread's first mail arrives — the creation batch carries the
 * `email-agent/created` birth certificate — and forwards every subsequent
 * `email/received` for the thread here, alongside the
 * `email/thread-route-configured` route context. `reduce` keeps the thread's
 * identity current: threadId and streamPath from birth and route context,
 * counterpart (the latest inbound Reply-To/From, via the shared
 * emailCounterpart chain) and subject from each real inbound mail — never
 * from the project's own looped-back mail, and never from automated mail
 * (a bounce must not become the reply target).
 *
 * `processEvent` has two consequences, both per-event and both under
 * `blockProcessorWhile`:
 *
 * - When a delivery changed the thread's identity (subject/counterpart), the
 *   agent's presence binding is refreshed with an `agent/binding-set` append
 *   — a dropped append would leave the sidebar's binding stale forever.
 * - Each inbound mail is transcribed into ONE `agents/context-added` item —
 *   the message's only path to the LLM, so a failed append holds the
 *   checkpoint and the redelivered frame retries. Door-stored attachments are
 *   resolved into signed AgentFileAttachments inside that blocked work;
 *   resolution failures degrade to an explicit loss note (never a silent
 *   drop, never a wedged frame). Automated mail is transcribed with
 *   `dont-trigger-request` — recorded, but never answered (the classic
 *   mail-loop guard). Replies leave through `itx.email.reply`, which reads
 *   this same stream; the processor itself sends nothing.
 */
export class EmailAgentProcessor extends StreamProcessor<
  EmailAgentProcessorContract,
  EmailAgentDeps
> {
  readonly contract = EmailAgentProcessorContract;

  // ------------------------------------------------------------ processEvent
  protected override processEvent(args: ProcessEventArgs<EmailAgentProcessorContract>): undefined {
    const { event, previousState, state, append, blockProcessorWhile } = args;

    switch (event?.type) {
      case "events.iterate.com/email/thread-route-configured": {
        if (!state.birthCertificate) return;
        const binding = refreshedThreadBinding({ previousState, state });
        if (binding) {
          blockProcessorWhile(() =>
            append({
              type: "events.iterate.com/agent/binding-set",
              idempotencyKey: this.idempotencyKey("binding", event),
              payload: binding,
            }),
          );
        }
        return;
      }
      case "events.iterate.com/email/received": {
        if (!state.birthCertificate) return;
        const binding = refreshedThreadBinding({ previousState, state });
        if (binding) {
          blockProcessorWhile(() =>
            append({
              type: "events.iterate.com/agent/binding-set",
              idempotencyKey: this.idempotencyKey("binding", event),
              payload: binding,
            }),
          );
        }

        // Never transcribe the project's own mail: a copy of our outbound
        // looping back inbound (e.g. the counterpart auto-forwards to the
        // same inbox) must not wake the agent to talk to itself.
        if (isOwnProjectMail(event.payload)) return;

        blockProcessorWhile(async () => {
          // Door-stored attachments become signed AgentFileAttachments so
          // images are directly visible to the model and documents are
          // itx.files readable. Resolution can fail PERMANENTLY (the file
          // may be gone from the bucket), so throwing would wedge this
          // frame forever; instead the message goes through WITH an
          // explicit loss note — never a silent drop — and the stored paths
          // in the transcription still let the agent reach any surviving
          // bytes via itx.files.get(path).
          const stored = (event.payload.message.attachments ?? []).filter(
            (attachment): attachment is typeof attachment & { path: string } =>
              typeof attachment.path === "string",
          );
          let files: AgentFileAttachment[] | undefined;
          let attachmentFailureNote: string | undefined;
          if (stored.length && this.deps.resolveStoredAttachments) {
            try {
              files = await this.deps.resolveStoredAttachments(
                stored.map((attachment) => ({
                  filename: attachment.filename ?? null,
                  mimeType: attachment.mimeType ?? null,
                  path: attachment.path,
                  size: attachment.size ?? 0,
                })),
              );
            } catch (error) {
              console.error("[email-agent] failed to resolve stored attachments", { error });
              attachmentFailureNote = `[${stored.length} attachment(s) could not be loaded: ${
                error instanceof Error ? error.message : String(error)
              }]`;
            }
          }
          // Normalized email is developer context; actor and refs retain
          // the untrusted sender and exact raw source coordinate.
          const fromAddress = event.payload.message.from.address ?? event.payload.envelope.from;
          const fromName = event.payload.message.from.name;
          try {
            await append({
              type: "events.iterate.com/agents/context-added",
              idempotencyKey: this.idempotencyKey("received-to-agent-context", event),
              payload: {
                role: "developer",
                content: !attachmentFailureNote
                  ? inboundEmailAgentInput(event.payload)
                  : `${inboundEmailAgentInput(event.payload)}\n\n${attachmentFailureNote}`,
                actor: {
                  type: "email" as const,
                  ...(!fromAddress ? {} : { address: fromAddress }),
                  ...(!fromName ? {} : { name: fromName }),
                },
                refs: [
                  {
                    type: "event" as const,
                    streamPath: event.path,
                    offset: event.offset,
                    eventType: event.type,
                  },
                ],
                ...(!files?.length ? {} : { files }),
                // Automated mail (Auto-Submitted, bulk precedence,
                // mailer-daemon) is recorded but never triggers a reply —
                // the classic mail-loop guard.
                ...(event.payload.automated && {
                  llmRequestPolicy: { behaviour: "dont-trigger-request" as const },
                }),
              },
            });
          } catch (error) {
            // A redelivery AFTER the transcription committed (crash between
            // append and cursor commit, or a fresh-cursor replay from
            // offset zero)
            // re-resolves the attachments and can mint DIFFERENT signed
            // URLs under the same idempotency key; the stream rejects the
            // same-key-different-body append. The committed transcription
            // stands — losing that race IS settlement, and rethrowing would
            // wedge the frame forever (every retry mints fresh URLs).
            if (!isIdempotencyConflict(error)) throw error;
          }
        });
        return;
      }
      // email-agent/created has no per-event effect; birth matters through the
      // reduction.
    }
  }

  // ------------------------------------------------------------------ reduce
  // Pure reduction, one switch, cases inline.
  protected override reduce({
    event,
    state,
  }: ReduceArgs<EmailAgentProcessorContract>): EmailAgentProcessorState {
    switch (event.type) {
      case "events.iterate.com/email-agent/created":
        if (state.birthCertificate) return state;
        return {
          ...state,
          birthCertificate: event.payload,
          threadId: event.payload.config.threadId,
          ...(!event.payload.config.counterpart
            ? {}
            : { counterpart: event.payload.config.counterpart }),
          ...(!event.payload.config.subject ? {} : { subject: event.payload.config.subject }),
        };
      case "events.iterate.com/email/thread-route-configured":
        return {
          ...state,
          threadId: event.payload.threadId,
          streamPath: event.payload.streamPath,
          ...(!event.payload.counterpart ? {} : { counterpart: event.payload.counterpart }),
          ...(!event.payload.subject ? {} : { subject: event.payload.subject }),
        };
      case "events.iterate.com/email/received": {
        // Neither our own looped-back mail nor automated mail (bounces,
        // Auto-Submitted) may become the thread counterpart.
        if (isOwnProjectMail(event.payload) || event.payload.automated) return state;
        const counterpart = emailCounterpart(event.payload);
        return {
          ...state,
          ...(!counterpart ? {} : { counterpart }),
          ...(!event.payload.message.subject ? {} : { subject: event.payload.message.subject }),
        };
      }
      default:
        return state;
    }
  }
}

// -----------------------------------------------------------------------------
// Injected dependencies.
// -----------------------------------------------------------------------------

/** One inbound attachment the door stored into project file storage. */
export type StoredInboundAttachment = {
  filename: string | null;
  mimeType: string | null;
  path: string;
  size: number;
};

export type EmailAgentDeps = {
  /** Turns door-stored attachment paths into signed AgentFileAttachments
   * (see the agent DO wiring in agent-durable-object.ts). Absent in tests. */
  resolveStoredAttachments?(attachments: StoredInboundAttachment[]): Promise<AgentFileAttachment[]>;
};

// -----------------------------------------------------------------------------
// Pure helpers.
// -----------------------------------------------------------------------------

/**
 * The refreshed presence binding when this delivery changed the thread's
 * identity (subject or counterpart), or null when nothing changed. Labels go
 * through normalizeAgentBindingLabel — the binding schema is strict about
 * length and shape where inbound mail headers are not.
 */
function refreshedThreadBinding(input: {
  previousState: EmailAgentProcessorState;
  state: EmailAgentProcessorState;
}): { type: "email_thread"; threadId: string; subject?: string; counterpart?: string } | null {
  const { previousState, state } = input;
  if (!state.threadId) return null;
  if (previousState.subject === state.subject && previousState.counterpart === state.counterpart) {
    return null;
  }
  const subject = normalizeAgentBindingLabel(state.subject);
  const counterpart = normalizeAgentBindingLabel(state.counterpart);
  return {
    type: "email_thread",
    threadId: state.threadId,
    ...(!subject ? {} : { subject }),
    ...(!counterpart ? {} : { counterpart }),
  };
}

/** The model-visible transcription of one inbound email. Curated rather than
 * the raw payload: html is omitted when a text body exists. */
function inboundEmailAgentInput(payload: InboundEmailPayload): string {
  const { message } = payload;
  // The stored path rides in the transcription too, not only in the files
  // attachment list: if attachment signing failed (no files list that turn),
  // the agent can still reach the bytes via itx.files.get(path).
  const attachments = message.attachments.map((attachment) => ({
    filename: attachment.filename ?? null,
    mimeType: attachment.mimeType ?? null,
    ...(!Number.isFinite(attachment.size) ? {} : { size: attachment.size }),
    ...(!attachment.path ? {} : { path: attachment.path }),
  }));
  const transcript = {
    from: { address: message.from.address ?? payload.envelope.from, name: message.from.name },
    ...(!message.replyToAddress ? {} : { replyTo: message.replyToAddress }),
    subject: message.subject ?? "",
    ...(!message.messageId ? {} : { messageId: message.messageId }),
    ...(!message.text ? {} : { text: message.text }),
    ...(!message.text && !!message.html && { html: message.html }),
    ...(!attachments.length ? {} : { attachments }),
    ...(payload.automated && { automated: true }),
  };
  return [
    "`events.iterate.com/email/received` event received",
    "",
    "```yaml",
    stringifyYaml(transcript).trimEnd(),
    "```",
  ].join("\n");
}
