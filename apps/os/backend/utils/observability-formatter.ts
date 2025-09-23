/*

once braintrust finally fixes their product we can remove these functions.
unfortunately, I came across an instance of two LLM spans with the exact same schema,
yet one of them rendered correctly, and the other didn't.

this doesn't work:
[
  {
    "id": "rs_68d2ac3b1194819093d9f019a37d2f540987f3f7dc2dcfb7",
    "summary": [],
    "type": "reasoning"
  },
  {
    "content": [
      {
        "annotations": [],
        "logprobs": [],
        "parsed": null,
        "text": "Hi! How can I help you with “poksada”? Do you want it reversed, defined, translated, or something else?",
        "type": "output_text"
      }
    ],
    "id": "msg_68d2ac3b33888190be67474267b2fcff0987f3f7dc2dcfb7",
    "role": "assistant",
    "status": "completed",
    "type": "message"
  }
]

and this does:
[
  {
    "id": "rs_68d2ae3fb9bc8193b2972fd32ac2669c01da10cb505fb7ab",
    "summary": [],
    "type": "reasoning"
  },
  {
    "content": [
      {
        "annotations": [],
        "logprobs": [],
        "parsed": null,
        "text": "654321",
        "type": "output_text"
      }
    ],
    "id": "msg_68d2ae3fe0388193bc12b056e520f1bb01da10cb505fb7ab",
    "role": "assistant",
    "status": "completed",
    "type": "message"
  }
]

so I will just have to go back to the old converter until they fix it.
same deal for posthog - although it's not as egregious, it does look nicer when we use this formatter.

*/

import type OpenAI from "openai";

export function formatItemsForObservability(messages: OpenAI.Responses.ResponseInputItem[]) {
  return messages
    .map((message) => {
      if (message.type === "message") {
        return {
          role: message.role,
          content:
            typeof message.content === "string"
              ? message.content
              : message.content
                  .map((c) => {
                    if ("text" in c) {
                      return c.text;
                    }
                    return c;
                  })
                  .join("\n\n"),
          type: message.type,
        };
      }
      if (message.type === "function_call") {
        return {
          role: "assistant",
          content: "Assistant used TRPC procedure",
          tool_calls: [
            {
              id: message.call_id,
              type: "function",
              function: {
                name: message.name,
                arguments: message.arguments,
              },
            },
          ],
        };
      }
      if (message.type === "function_call_output") {
        return {
          role: "tool",
          content: message.output,
          tool_call_id: message.call_id,
        };
      }
      if (message.type === "reasoning") {
        return {
          role: "assistant",
          content: message.content?.map((c) => c.text).join("\n\n"),
          type: message.type,
        };
      }
      return message;
    })
    .filter(Boolean);
}
