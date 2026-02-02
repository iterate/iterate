import type { EgressHandler, EgressRequest } from "./types.ts";

function requestWantsStream(req: EgressRequest): boolean {
  if (!req.body || typeof req.body !== "object") return false;
  if (!("stream" in req.body)) return false;
  return Boolean((req.body as { stream?: boolean }).stream);
}

export function mockOpenAIChat(responseText: string): EgressHandler {
  return (req) => {
    if (requestWantsStream(req)) {
      const created = Math.floor(Date.now() / 1000);
      const id = "chatcmpl-mock";
      return new Response(
        [
          `data: {"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"gpt-mock","choices":[{"index":0,"delta":{"content":"${responseText}"},"finish_reason":null}]}\n\n`,
          `data: {"id":"${id}","object":"chat.completion.chunk","created":${created},"model":"gpt-mock","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        {
          headers: { "Content-Type": "text/event-stream; charset=utf-8" },
        },
      );
    }
    return new Response(
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: Date.now(),
        model: "gpt-mock",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: responseText },
            finish_reason: "stop",
          },
        ],
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  };
}

export function mockOpenAIChatJson(responseText: string): EgressHandler {
  return () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: Date.now(),
        model: "gpt-mock",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: responseText },
            finish_reason: "stop",
          },
        ],
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
}

export function mockAnthropicMessages(responseText: string): EgressHandler {
  return (req) => {
    if (requestWantsStream(req)) {
      const messageId = "msg_mock";
      return new Response(
        [
          `event: message_start\ndata: {"type":"message_start","message":{"id":"${messageId}","type":"message","role":"assistant","model":"claude-mock","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n`,
          `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
          `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${responseText}"}}\n\n`,
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join(""),
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    }
    return new Response(
      JSON.stringify({
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: "claude-mock",
        content: [{ type: "text", text: responseText }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  };
}

export function mockAnthropicCountTokens(): EgressHandler {
  return () =>
    new Response(
      JSON.stringify({
        input_tokens: 10,
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
}

export function mockAnthropicClaudeCodeSettings(): EgressHandler {
  return () =>
    new Response(
      JSON.stringify({
        settings: {},
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
}
