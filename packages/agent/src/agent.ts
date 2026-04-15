import { defineProcessor, PullProcessorRuntime } from "ai-engineer-workshop";
import { chat } from "@tanstack/ai";
import { openaiText } from "@tanstack/ai-openai";
import z from "zod";

const AgentInput = z.object({
  content: z.string(),
  role: z.enum(["user", "assistant"]),
});

export const AgentInputEvent = z.object({
  type: z.literal("agent-input-added"),
  payload: AgentInput,
});

export const MessageAddedEvent = z.object({
  type: z.literal("message-added"),
  payload: z.object({
    message: z.string(),
  }),
});

type AgentState = {
  history: z.infer<typeof AgentInput>[];
};

export const processor = defineProcessor<AgentState>(() => ({
  slug: "agent",
  initialState: { history: [] },
  reduce: ({ event, state }) => {
    const { success, data } = AgentInputEvent.safeParse(event);
    if (success) {
      return { history: [...state.history, data.payload] };
    }
  },
  afterAppend: async ({ append, event, state, logger }) => {
    const { success, data } = AgentInputEvent.safeParse(event);
    if (!success || data.payload.role !== "user") {
      logger.info("Ignoring event", event);
      return;
    }

    console.log("Making LLM request for event", data);

    const response = await chat({
      adapter: openaiText("gpt-5.2"),
      systemPrompts: [
        "You are a general purpose AI agent built using the iterate agent harness.",
        "All actions you take are accomplished by producing JavaScript in a ```js block.",
        "Each response MUST contain exactly one ```js block and no prose outside it.",
        "The block must be an async arrow function.",
        "Do not use TypeScript syntax.",
        "To communicate with the user, use `codemode.sendMessage({ message: string })`.",
        "To append raw events, use `codemode.append({ event: { type, payload } })`.",
      ],
      messages: state.history,
      stream: false,
    });
    await append({
      event: {
        type: "agent-input-added",
        payload: {
          content: response,
          role: "assistant",
        },
      },
    });
  },
}));

if (import.meta.main) {
  await new PullProcessorRuntime({
    path: "/jonas",
    includeChildren: true,
    processor,
  }).run();
}
