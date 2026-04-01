/**
 * Pi-native stream processor with a single `fetch` tool.
 *
 * `user-prompt` events trigger pi. Every pi AgentEvent is appended back into
 * the stream so the log becomes a full transcript of the run.
 *
 * Run with `pnpm workshop run` and select this script.
 * Override `BASE_URL`, `WORKSHOP_PATH_PREFIX`, `STREAM_PATH`, `PI_PROVIDER`, or `PI_MODEL` if needed.
 */
import { randomBytes } from "node:crypto";
import { Agent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import { getEnvApiKey, getModels, registerBuiltInApiProviders, Type } from "@mariozechner/pi-ai";
import { z } from "zod";
import {
  createEventsClient,
  defineProcessor,
  type JSONObject,
  PullSubscriptionProcessorRuntime,
} from "ai-engineer-workshop";

registerBuiltInApiProviders();

const PI_PROVIDER = z
  .enum(["openai", "anthropic", "google"])
  .parse(process.env.PI_PROVIDER ?? "openai");
const PI_MODEL = process.env.PI_MODEL ?? "gpt-4o-mini";

const models = getModels(PI_PROVIDER);
const model = models.find((candidate) => candidate.id === PI_MODEL);
if (!model) {
  const available = models.map((candidate) => candidate.id);
  throw new Error(
    `Model "${PI_MODEL}" not found for provider "${PI_PROVIDER}". Available: ${available.join(", ")}`,
  );
}

const FetchParams = Type.Object({
  url: Type.String({ description: "The URL to fetch" }),
  method: Type.Optional(Type.String({ description: 'HTTP method (default: "GET")' })),
  headers: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "HTTP headers to send",
    }),
  ),
  body: Type.Optional(Type.String({ description: "Request body (for POST/PUT/PATCH)" })),
});

const fetchTool: AgentTool<typeof FetchParams> = {
  name: "fetch",
  label: "Fetch URL",
  description:
    "Make an HTTP request using JavaScript fetch(). " +
    "Use this to retrieve web pages, call APIs, or download data from the internet. " +
    "Returns the response status, headers, and body text.",
  parameters: FetchParams,
  async execute(_toolCallId, params, signal, onUpdate) {
    const { url, method = "GET", headers, body } = params;
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal,
    });
    const statusLine = `${response.status} ${response.statusText}`;
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    const responseBody = await response.text();
    const MAX_BODY = 50_000;
    const truncated = responseBody.length > MAX_BODY;
    const displayBody = truncated
      ? responseBody.slice(0, MAX_BODY) + `\n\n[truncated at ${MAX_BODY} chars]`
      : responseBody;
    const details = {
      url,
      method,
      status: response.status,
      responseHeaders,
      bodyLength: responseBody.length,
      truncated,
    };

    onUpdate?.({
      content: [{ type: "text", text: `${statusLine}\n\n${displayBody}` }],
      details,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `HTTP ${statusLine}`,
            "",
            "Response Headers:",
            ...Object.entries(responseHeaders).map(([k, v]) => `  ${k}: ${v}`),
            "",
            "Body:",
            displayBody,
          ].join("\n"),
        },
      ],
      details,
    };
  },
};

const agent = new Agent({
  initialState: {
    systemPrompt:
      "You are a helpful assistant with access to the internet via a fetch tool. " +
      "Use it when asked to look something up, call an API, or retrieve web content. " +
      "Keep responses concise.",
    model,
    thinkingLevel: "off",
    tools: [fetchTool],
  },
  getApiKey: getEnvApiKey,
});

const UserPromptPayload = z.object({
  content: z.string().min(1),
});

const processor = defineProcessor({
  initialState: { agentRunning: false },

  reduce: (_state, event) => {
    if (event.type === "agent_start" || event.type === "agent_end") {
      return { agentRunning: event.type === "agent_start" };
    }
  },

  onEvent: async ({ append, event, prevState }) => {
    if (event.type !== "user-prompt" || prevState.agentRunning) return;

    const prompt = UserPromptPayload.safeParse(event.payload);
    if (!prompt.success) return;

    console.log(`User prompt at offset=${event.offset}`);

    // Pi emits synchronously, but `append()` is async, so serialize writes to
    // keep the stream log in the same order pi produced the events.
    let flushing = Promise.resolve();
    const unsubscribe = agent.subscribe((piEvent: AgentEvent) => {
      flushing = flushing.then(() =>
        append({
          type: piEvent.type,
          payload: serializePiEvent(piEvent),
        }),
      );
    });

    try {
      await agent.prompt(prompt.data.content);
      await flushing;
    } finally {
      unsubscribe();
    }

    console.log(`Done offset=${event.offset}`);
  },
});

export default async function piAgentProcessor(pathPrefix: string) {
  const baseUrl = process.env.BASE_URL || "https://events.iterate.com";
  const streamPath =
    process.env.STREAM_PATH ||
    `${normalizePathPrefix(pathPrefix)}/04/${randomBytes(4).toString("hex")}`;

  console.log(`\
Pi Agent Processor
  provider: ${PI_PROVIDER}
  model:    ${PI_MODEL}
  stream:   ${streamPath}

Open in browser:
  ${new URL(`/streams${streamPath}`, baseUrl)}

Paste this JSON into the stream page to trigger:
${JSON.stringify(
  {
    type: "user-prompt",
    payload: { content: "What is the current top story on Hacker News? Use fetch to find out." },
  },
  null,
  2,
)}
`);

  await new PullSubscriptionProcessorRuntime({
    eventsClient: createEventsClient(baseUrl),
    processor,
    streamPath,
  }).run();
}

function serializePiEvent(event: AgentEvent): JSONObject {
  const { type: _type, ...rest } = event;
  return toJsonObject(rest, (_key, value) => {
    if (value instanceof Set) return [...value];
    return value;
  });
}

function normalizePathPrefix(pathPrefix: string) {
  return pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
}

function toJsonObject(
  value: unknown,
  replacer?: (key: string, value: unknown) => unknown,
): JSONObject {
  const json = JSON.parse(JSON.stringify(value, replacer));
  if (json == null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("Expected a JSON object payload");
  }
  return json as JSONObject;
}
