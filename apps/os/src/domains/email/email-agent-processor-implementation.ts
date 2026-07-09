// Implements the "email-agent" processor on itx, shaped after the slack-agent
// processor. Emitted event types, payloads, and idempotency keys are stable
// wire formats.

import { stringify as stringifyYaml } from "yaml";
import { StreamProcessor } from "../streams/stream-processor.ts";
import type { AgentFileAttachment } from "../agents/agent-processor-contract.ts";
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
  }: Parameters<
    StreamProcessor<typeof EmailAgentProcessorContract>["processEvent"]
  >[0]): undefined {
    if (event.type !== "events.iterate.com/email/received") return;

    // Never transcribe the project's own mail: a copy of our outbound looping
    // back inbound (e.g. the counterpart auto-forwards to the same inbox)
    // must not wake the agent to talk to itself.
    if (isOwnProjectMail(event.payload)) return;

    // Durable obligation: the agent input is the message's only path to the
    // LLM, so a failed append must hold the checkpoint and replay.
    blockProcessorWhile(async () => {
      // Door-stored attachments become signed AgentFileAttachments so images
      // are directly visible to the model and documents are itx.files
      // readable. A failed resolution degrades to the plain transcription
      // (the YAML already names the files) rather than wedging the processor.
      const stored = (event.payload.message.attachments ?? []).filter(
        (attachment): attachment is StoredInboundAttachment & { size: number } =>
          typeof attachment.path === "string",
      );
      let files: AgentFileAttachment[] | undefined;
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
        }
      }
      await append({
        type: "events.iterate.com/agent/input-added",
        idempotencyKey: this.idempotencyKey("received-to-agent-input", event),
        payload: {
          content: inboundEmailAgentInput(event.payload),
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
