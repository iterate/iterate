// Implements the "email-agent" processor on itx, shaped after the slack-agent
// processor. Emitted event types, payloads, and idempotency keys are stable
// wire formats.

import { stringify as stringifyYaml } from "yaml";
import { StreamProcessor } from "iterate/processors";
import type { AgentFileAttachment } from "../agents/agent-processor-contract.ts";
import { normalizeAgentBindingLabel } from "../agents/agent-presence.ts";
import type { InboundEmailPayload } from "./email-processor-contract.ts";
import { emailCounterpart, isOwnProjectMail } from "./utils.ts";
import {
  EmailAgentProcessorContract,
  type EmailAgentProcessorState,
} from "./email-agent-processor-contract.ts";

/** One inbound attachment the door stored into project file storage. */
type StoredInboundAttachment = {
  filename: string | null;
  mimeType: string | null;
  path: string;
  size: number;
};

export class EmailAgentProcessor extends StreamProcessor<
  typeof EmailAgentProcessorContract,
  {
    /** Turns door-stored attachment paths into signed AgentFileAttachments
     * (see attachInboundEmailFiles in the agent DO wiring). Absent in tests. */
    resolveStoredAttachments?(
      attachments: StoredInboundAttachment[],
    ): Promise<AgentFileAttachment[]>;
  }
> {
  readonly contract = EmailAgentProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<
    StreamProcessor<typeof EmailAgentProcessorContract>["reduce"]
  >[0]): EmailAgentProcessorState {
    switch (event.type) {
      case "events.iterate.com/email-agent/created":
        if (state.birthCertificate !== null) {
          throw new Error("Email agent processor received more than one email-agent/created event");
        }
        return {
          ...state,
          birthCertificate: event.payload,
          threadId: event.payload.config.threadId,
          ...(event.payload.config.counterpart === undefined
            ? {}
            : { counterpart: event.payload.config.counterpart }),
          ...(event.payload.config.subject === undefined
            ? {}
            : { subject: event.payload.config.subject }),
        };
      case "events.iterate.com/email/thread-route-configured":
        return {
          ...state,
          threadId: event.payload.threadId,
          streamPath: event.payload.streamPath,
          ...(event.payload.counterpart === undefined
            ? {}
            : { counterpart: event.payload.counterpart }),
          ...(event.payload.subject === undefined ? {} : { subject: event.payload.subject }),
        };
      case "events.iterate.com/email/received": {
        // Neither our own looped-back mail nor automated mail (bounces,
        // Auto-Submitted) may become the thread counterpart.
        if (isOwnProjectMail(event.payload) || event.payload.automated) return state;
        const counterpart = emailCounterpart(event.payload);
        return {
          ...state,
          ...(counterpart === null ? {} : { counterpart }),
          ...(event.payload.message.subject === undefined
            ? {}
            : { subject: event.payload.message.subject }),
        };
      }
      default:
        return state;
    }
  }

  protected override processEvent({
    append,
    blockProcessorWhile,
    event,
    previousState,
    state,
  }: Parameters<
    StreamProcessor<typeof EmailAgentProcessorContract>["processEvent"]
  >[0]): undefined {
    // Event-less at-head pass: this processor has no at-head work.
    if (event === null) return;
    if (event.type === "events.iterate.com/email-agent/created") return;
    if (state.birthCertificate === null) return;

    const identityChanged =
      previousState.subject !== state.subject || previousState.counterpart !== state.counterpart;
    const threadId = state.threadId;
    if (identityChanged && threadId !== undefined) {
      const subject = normalizeAgentBindingLabel(state.subject);
      const counterpart = normalizeAgentBindingLabel(state.counterpart);
      blockProcessorWhile(() =>
        append({
          type: "events.iterate.com/agent/binding-set",
          idempotencyKey: this.idempotencyKey("binding", event),
          payload: {
            type: "email_thread",
            threadId,
            ...(subject === undefined ? {} : { subject }),
            ...(counterpart === undefined ? {} : { counterpart }),
          },
        }),
      );
    }

    if (event.type !== "events.iterate.com/email/received") return;

    // Never transcribe the project's own mail: a copy of our outbound looping
    // back inbound (e.g. the counterpart auto-forwards to the same inbox)
    // must not wake the agent to talk to itself.
    if (isOwnProjectMail(event.payload)) return;

    // Durable obligation: the agent context item is the message's only path to the
    // LLM, so a failed append must hold the checkpoint and replay.
    blockProcessorWhile(async () => {
      // Door-stored attachments become signed AgentFileAttachments so images
      // are directly visible to the model and documents are itx.files
      // readable. Resolution can fail PERMANENTLY (the file may be gone from
      // the bucket), so throwing would wedge this frame forever; instead the
      // message goes through WITH an explicit loss note — never a silent
      // drop — and the stored paths in the transcription still let the agent
      // reach any surviving bytes via itx.files.get(path).
      const stored = (event.payload.message.attachments ?? []).filter(
        (attachment): attachment is StoredInboundAttachment & { size: number } =>
          typeof attachment.path === "string",
      );
      let files: AgentFileAttachment[] | undefined;
      let attachmentFailureNote: string | undefined;
      if (stored.length > 0 && this.deps.resolveStoredAttachments != null) {
        try {
          files = await this.deps.resolveStoredAttachments(
            stored.map((attachment) => ({
              filename: attachment.filename ?? null,
              mimeType: attachment.mimeType ?? null,
              path: attachment.path!,
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
      // Normalized email is developer context; actor and refs retain the
      // untrusted sender and exact raw source coordinate.
      const fromAddress = event.payload.message.from.address ?? event.payload.envelope.from;
      const fromName = event.payload.message.from.name;
      await append({
        type: "events.iterate.com/agents/context-added",
        idempotencyKey: this.idempotencyKey("received-to-agent-context", event),
        payload: {
          role: "developer",
          content:
            attachmentFailureNote === undefined
              ? inboundEmailAgentInput(event.payload)
              : `${inboundEmailAgentInput(event.payload)}\n\n${attachmentFailureNote}`,
          actor: {
            type: "email" as const,
            ...(fromAddress == null ? {} : { address: fromAddress }),
            ...(fromName == null ? {} : { name: fromName }),
          },
          refs: [
            {
              type: "event" as const,
              streamPath: event.path,
              offset: event.offset,
              eventType: event.type,
            },
          ],
          ...(files == null || files.length === 0 ? {} : { files }),
          // Automated mail (Auto-Submitted, bulk precedence, mailer-daemon) is
          // recorded but never triggers a reply — the classic mail-loop guard.
          ...(event.payload.automated
            ? { llmRequestPolicy: { behaviour: "dont-trigger-request" as const } }
            : {}),
        },
      });
    });
  }
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
    ...(attachment.size === undefined ? {} : { size: attachment.size }),
    ...(attachment.path === undefined ? {} : { path: attachment.path }),
  }));
  const transcript = {
    from: { address: message.from.address ?? payload.envelope.from, name: message.from.name },
    ...(message.replyToAddress == null ? {} : { replyTo: message.replyToAddress }),
    subject: message.subject ?? "",
    ...(message.messageId == null ? {} : { messageId: message.messageId }),
    ...(message.text === undefined ? {} : { text: message.text }),
    ...(message.text === undefined && message.html !== undefined ? { html: message.html } : {}),
    ...(attachments.length === 0 ? {} : { attachments }),
    ...(payload.automated ? { automated: true } : {}),
  };
  return [
    "`events.iterate.com/email/received` event received",
    "",
    "```yaml",
    stringifyYaml(transcript).trimEnd(),
    "```",
  ].join("\n");
}
