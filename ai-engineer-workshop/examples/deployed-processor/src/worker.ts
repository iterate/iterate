import {
  createEventsClient,
  defineProcessor,
  type StreamProcessor,
} from "ai-engineer-workshop/runtime";
import type { Context } from "hono";
import { createAfterEventHandlerApp } from "./hono-processor-runtime.ts";
import { createOpenAiAgentProcessor } from "./openai-agent-processor.ts";
import { createPingPongProcessor } from "./ping-pong-processor.ts";

type Bindings = {
  EVENTS_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  PROCESSOR_KIND?: string;
};

const DEFAULT_EVENTS_BASE_URL = "https://prd-events.iterate.workers.dev";
const LOCAL_EVENTS_BASE_URL = "http://localhost:5173";
const DEFAULT_PROCESSOR_KIND = "ping-pong";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

const app = createAfterEventHandlerApp<Bindings, unknown>({
  getEventsClient: (c) => createEventsClient(getEventsBaseUrl(c)),
  getEventsClientKey: (c) => getEventsBaseUrl(c),
  getProcessor: (c) => {
    const processorKind = getProcessorKind(c);

    if (processorKind === "openai-agent") {
      const apiKey = getEnvVar(c, "OPENAI_API_KEY");
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY is required when PROCESSOR_KIND=openai-agent");
      }

      return eraseProcessor(
        createOpenAiAgentProcessor({
          apiKey,
          model: getOpenAiModel(c),
        }),
      );
    }

    return eraseProcessor(createPingPongProcessor());
  },
  getProcessorKey: (c) => {
    const processorKind = getProcessorKind(c);

    if (processorKind === "openai-agent") {
      return `${processorKind}:${getOpenAiModel(c)}`;
    }

    return processorKind;
  },
});

export default app;

function getEventsBaseUrl(c: Context<{ Bindings: Bindings }>) {
  const requestUrl = new URL(c.req.url);

  if (requestUrl.hostname === "127.0.0.1" || requestUrl.hostname === "localhost") {
    return getEnvVar(c, "EVENTS_BASE_URL") || LOCAL_EVENTS_BASE_URL;
  }

  return getEnvVar(c, "EVENTS_BASE_URL") || DEFAULT_EVENTS_BASE_URL;
}

function getProcessorKind(c: Context<{ Bindings: Bindings }>) {
  const queryValue = c.req.query("processorKind");
  if (queryValue != null && queryValue.length > 0) {
    return queryValue;
  }

  return getEnvVar(c, "PROCESSOR_KIND") || DEFAULT_PROCESSOR_KIND;
}

function getOpenAiModel(c: Context<{ Bindings: Bindings }>) {
  const queryValue = c.req.query("openaiModel");
  if (queryValue != null && queryValue.length > 0) {
    return queryValue;
  }

  return getEnvVar(c, "OPENAI_MODEL") || DEFAULT_OPENAI_MODEL;
}

function eraseProcessor<State>(processor: StreamProcessor<State>) {
  return defineProcessor<unknown>({
    initialState: structuredClone(processor.initialState),
    reduce: (state, event) => processor.reduce(state as State, event),
    onEvent: processor.onEvent
      ? async ({ append, event, state, prevState }) => {
          await processor.onEvent?.({
            append,
            event,
            state: state as State,
            prevState: prevState as State,
          });
        }
      : undefined,
  });
}

function getEnvVar(c: Context<{ Bindings: Bindings }>, key: keyof Bindings) {
  const bindingValue = c.env[key];

  if (typeof bindingValue === "string" && bindingValue.length > 0) {
    return bindingValue;
  }

  if (
    !("process" in globalThis) ||
    typeof globalThis.process !== "object" ||
    globalThis.process == null
  ) {
    return undefined;
  }

  const processValue = globalThis.process.env?.[key];
  return typeof processValue === "string" && processValue.length > 0 ? processValue : undefined;
}
