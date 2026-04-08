import {
  createEventsClient,
  normalizeStreamPattern,
  type Processor,
} from "ai-engineer-workshop/runtime";
import type { Context } from "hono";
import { createAfterEventHandlerApp } from "./hono-processor-runtime.ts";
import { createOpenAiAgentProcessor } from "./openai-agent-processor.ts";
import { createPingPongProcessor } from "./ping-pong-processor.ts";

type Bindings = {
  EVENTS_BASE_URL?: string;
  EVENTS_PROJECT_SLUG?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  PROCESSOR_KIND?: string;
  STREAM_PATTERN?: string;
};

const DEFAULT_EVENTS_BASE_URL = "https://events.iterate.com";
const LOCAL_EVENTS_BASE_URL = "http://127.0.0.1:5173";
const DEFAULT_PROCESSOR_KIND = "ping-pong";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_STREAM_PATTERN = "/**/*";
const eventsClientByKey = new Map<string, ReturnType<typeof createEventsClient>>();
const processorByKey = new Map<string, Processor<unknown>>();

const app = createAfterEventHandlerApp<Bindings, unknown>({
  getConfig: (c) => resolveConfig(c),
  getEventsClient: ({ baseUrl, projectSlug }) => getCachedEventsClient({ baseUrl, projectSlug }),
});

export default app;

function resolveConfig(c: Context<{ Bindings: Bindings }>) {
  const query = new URL(c.req.url).searchParams;
  const env = {
    EVENTS_BASE_URL: readAmbientValue(c, "EVENTS_BASE_URL"),
    EVENTS_PROJECT_SLUG: readAmbientValue(c, "EVENTS_PROJECT_SLUG"),
    OPENAI_API_KEY: readAmbientValue(c, "OPENAI_API_KEY"),
    OPENAI_MODEL: readAmbientValue(c, "OPENAI_MODEL"),
    PROCESSOR_KIND: readAmbientValue(c, "PROCESSOR_KIND"),
    STREAM_PATTERN: readAmbientValue(c, "STREAM_PATTERN"),
  };
  const isLocalRequest = isLocalHostname(new URL(c.req.url).hostname);
  const baseUrl =
    query.get("baseUrl") ||
    env.EVENTS_BASE_URL ||
    (isLocalRequest ? LOCAL_EVENTS_BASE_URL : DEFAULT_EVENTS_BASE_URL);
  const projectSlug =
    query.get("projectSlug") ||
    env.EVENTS_PROJECT_SLUG ||
    (isLocalEventsBaseUrl(baseUrl) ? "test" : undefined);
  const processorKind = query.get("processorKind") || env.PROCESSOR_KIND || DEFAULT_PROCESSOR_KIND;
  const openAiModel = query.get("openaiModel") || env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
  const streamPattern = normalizeStreamPattern(
    query.get("streamPattern") || env.STREAM_PATTERN || DEFAULT_STREAM_PATTERN,
  );

  if (processorKind === "openai-agent") {
    if (env.OPENAI_API_KEY == null) {
      throw new Error("OPENAI_API_KEY is required when PROCESSOR_KIND=openai-agent");
    }
    const openAiApiKey = env.OPENAI_API_KEY;

    return {
      baseUrl,
      projectSlug,
      openAiModel,
      processor: getCachedProcessor({
        key: JSON.stringify(["openai-agent", openAiModel, openAiApiKey]),
        create: () =>
          eraseProcessor(
            createOpenAiAgentProcessor({
              apiKey: openAiApiKey,
              model: openAiModel,
            }),
          ),
      }),
      processorDescription:
        "It reacts to user-message events by asking OpenAI for a response and appending openai-response-output plus assistant-message events.",
      processorKey: `${processorKind}:${openAiModel}`,
      processorKind,
      streamPattern,
    };
  }

  return {
    baseUrl,
    projectSlug,
    processor: getCachedProcessor({
      key: processorKind,
      create: () => eraseProcessor(createPingPongProcessor()),
    }),
    processorDescription:
      'It reacts to any event whose type or payload contains the word "ping" by appending a pong event.',
    processorKey: processorKind,
    processorKind,
    streamPattern,
  };
}

function getCachedEventsClient(args: { baseUrl: string; projectSlug?: string }) {
  const cacheKey = JSON.stringify([args.baseUrl, args.projectSlug]);
  const cached = eventsClientByKey.get(cacheKey);
  if (cached != null) {
    return cached;
  }

  const eventsClient = createEventsClient({
    baseUrl: args.baseUrl,
    projectSlug: args.projectSlug,
  });
  eventsClientByKey.set(cacheKey, eventsClient);
  return eventsClient;
}

function getCachedProcessor(args: { key: string; create: () => Processor<unknown> }) {
  const cached = processorByKey.get(args.key);
  if (cached != null) {
    return cached;
  }

  const processor = args.create();
  processorByKey.set(args.key, processor);
  return processor;
}

function readAmbientValue(c: Context<{ Bindings: Bindings }>, key: keyof Bindings) {
  const bindingValue = c.env[key];
  if (typeof bindingValue === "string" && bindingValue.length > 0) {
    return bindingValue;
  }

  const processValue =
    typeof globalThis.process === "object" && globalThis.process != null
      ? globalThis.process.env?.[key]
      : undefined;
  return typeof processValue === "string" && processValue.length > 0 ? processValue : undefined;
}

function isLocalHostname(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "localhost";
}

function isLocalEventsBaseUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  return isLocalHostname(url.hostname);
}

function eraseProcessor<State>(processor: Processor<State>) {
  return processor as Processor<unknown>;
}
