// Implements the "email-agent" processor on itx
// (tasks/email-agent-zero-onboarding.md). Modeled on
// slack-agent-processor-implementation.ts: the router forwarded the raw
// email/received fact here; this processor transcribes it into agent input.
// The reply door (itx.email.send with threading headers) is the agent's own
// move, instructed by EMAIL_AGENT_SYSTEM_PROMPT — the same "agent path decides
// the reply door" mechanism Slack uses.

import { stringify as stringifyYaml } from "yaml";
import { StreamProcessor } from "../streams/stream-processor.ts";
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
    if (event.type !== "events.iterate.com/email/received") return state;
    const payload = event.payload;
    return {
      ...state,
      senderAddress: payload.from.address,
      ...(payload.from.name ? { senderName: payload.from.name } : {}),
      subject: payload.subject,
      lastInboundMessageId: payload.messageId,
      // What the next reply's References header should carry: the inbound
      // mail's own ancestry plus its Message-ID.
      references: [...payload.references, payload.messageId],
    };
  }

  protected override processEvent({
    append,
    blockProcessorWhile,
    event,
  }: Parameters<
    StreamProcessor<typeof EmailAgentProcessorContract>["processEvent"]
  >[0]): undefined {
    if (event.type !== "events.iterate.com/email/received") return;

    // Durable obligation: this transcription is the only copy of the email on
    // its way into the agent transcript (same reasoning as the Slack agent
    // processor's blockProcessorWhile appends).
    blockProcessorWhile(async () => {
      await append({
        type: "events.iterate.com/agent/input-added",
        idempotencyKey: `email-agent:received-to-agent-input:${event.offset}`,
        payload: { content: emailReceivedAgentInput(event.payload) },
      });
    });
  }
}

function emailReceivedAgentInput(payload: unknown) {
  return [
    "`events.iterate.com/email/received` event received",
    "",
    "```yaml",
    stringifyYaml(payload).trimEnd(),
    "```",
  ].join("\n");
}
