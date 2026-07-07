// Implements the "email-agent" processor on itx, shaped after the slack-agent
// processor. Emitted event types, payloads, and idempotency keys are stable
// wire formats.

import { stringify as stringifyYaml } from "yaml";
import { StreamProcessor } from "../streams/stream-processor.ts";
import type { InboundEmailPayload } from "./email-processor-contract.ts";
import {
  EmailAgentProcessorContract,
  type EmailAgentProcessorState,
} from "./email-agent-processor-contract.ts";

export class EmailAgentProcessor extends StreamProcessor<typeof EmailAgentProcessorContract> {
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
        const counterpart = replyCounterpart(event.payload);
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
      await append({
        type: "events.iterate.com/agent/input-added",
        idempotencyKey: `email-agent:received-to-agent-input:${event.offset}`,
        payload: {
          content: inboundEmailAgentInput(event.payload),
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

/** The address a reply should go to: the inbound Reply-To when set, else From. */
function replyCounterpart(payload: InboundEmailPayload): string | null {
  return payload.message.replyToAddress ?? payload.message.from.address ?? null;
}

/** True when the mail's author is the receiving project's own address. */
function isOwnProjectMail(payload: InboundEmailPayload): boolean {
  const from = payload.message.from.address?.toLowerCase();
  if (from === undefined) return false;
  const recipientDomain = payload.envelope.to.split("@").pop()?.toLowerCase();
  return from === `${payload.recipient.slug}@${recipientDomain}`;
}

/** The model-visible transcription of one inbound email. Curated rather than
 * the raw payload: html is omitted when a text body exists, and attachment
 * contents were never captured (metadata only in this slice). */
function inboundEmailAgentInput(payload: InboundEmailPayload): string {
  const { message } = payload;
  const attachments = message.attachments.map((attachment) => ({
    filename: attachment.filename ?? null,
    mimeType: attachment.mimeType ?? null,
    ...(attachment.size === undefined ? {} : { size: attachment.size }),
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
