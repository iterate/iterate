import { setTimeout as sleep } from "node:timers/promises";

type SmokeOptions = {
  agentsBaseUrl: string;
  eventsBaseUrl: string;
  streamPath: string;
  expected: string;
  timeoutMs: number;
};

type StreamEvent = {
  type: string;
  payload?: unknown;
  offset?: number;
};

type CreateAgentResult = {
  streamPath: string;
  streamViewerUrl: string;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const deadline = Date.now() + options.timeoutMs;

  await postJson({
    url: new URL("/api/install-processor", options.agentsBaseUrl),
    body: { publicBaseUrl: options.agentsBaseUrl },
  });

  const createAgentResult = await postJson<CreateAgentResult>({
    url: new URL("/api/create-agent", options.agentsBaseUrl),
    body: {
      streamPath: options.streamPath,
      initialPrompt: `Please reply by running codemode that calls webchat.sendMessage with exactly ${options.expected}.`,
    },
  });

  let lastEvents: StreamEvent[] = [];
  while (Date.now() < deadline) {
    lastEvents = await readStreamEvents({
      eventsBaseUrl: options.eventsBaseUrl,
      streamPath: options.streamPath,
    });

    const matchingResponse = lastEvents.find((event) => {
      if (event.type !== "events.iterate.com/webchat/agent-response-added") return false;
      if (!isRecord(event.payload)) return false;
      return event.payload.message === options.expected;
    });

    if (matchingResponse != null) {
      console.info(
        JSON.stringify(
          {
            ok: true,
            streamPath: createAgentResult.streamPath,
            streamViewerUrl: createAgentResult.streamViewerUrl,
            responseOffset: matchingResponse.offset ?? null,
            response: options.expected,
          },
          null,
          2,
        ),
      );
      return;
    }

    await sleep(1_000);
  }

  throw new Error(
    [
      `Timed out after ${options.timeoutMs}ms waiting for events.iterate.com/webchat/agent-response-added with payload.message=${JSON.stringify(options.expected)}.`,
      `Stream path: ${options.streamPath}`,
      `Last event types: ${lastEvents.map((event) => event.type).join(", ") || "(none)"}`,
    ].join("\n"),
  );
}

function parseArgs(args: string[]): SmokeOptions {
  if (args.includes("--help") || args.includes("-h")) {
    console.info(`Usage: pnpm smoke:agent-chat -- [options]

Options:
  --agents-base-url <url>  Agents app origin. Defaults to AGENTS_BASE_URL or http://localhost:5174
  --events-base-url <url>  Events app origin. Defaults to EVENTS_BASE_URL or http://localhost:5173
  --stream-path <path>     Stream path to create. Defaults to /agents/smoke-<timestamp>
  --expected <text>        Expected webchat response. Defaults to "hello from smoke test"
  --timeout-ms <ms>        Poll timeout. Defaults to 60000
`);
    process.exit(0);
  }

  const values = readFlagValues(args);
  const agentsBaseUrl = stripTrailingSlash(
    values.get("agents-base-url") ?? process.env.AGENTS_BASE_URL ?? "http://localhost:5174",
  );
  const eventsBaseUrl = stripTrailingSlash(
    values.get("events-base-url") ?? process.env.EVENTS_BASE_URL ?? "http://localhost:5173",
  );
  const streamPath = values.get("stream-path") ?? `/agents/smoke-${Date.now()}`;
  const expected = values.get("expected") ?? "hello from smoke test";
  const timeoutMsText = values.get("timeout-ms") ?? "60000";
  const timeoutMs = Number.parseInt(timeoutMsText, 10);

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `--timeout-ms must be a positive integer, got ${JSON.stringify(timeoutMsText)}`,
    );
  }
  if (!streamPath.startsWith("/")) {
    throw new Error(`--stream-path must start with "/", got ${JSON.stringify(streamPath)}`);
  }

  return { agentsBaseUrl, eventsBaseUrl, streamPath, expected, timeoutMs };
}

function readFlagValues(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") continue;
    if (!arg.startsWith("--")) continue;

    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex >= 0) {
      values.set(withoutPrefix.slice(0, equalsIndex), withoutPrefix.slice(equalsIndex + 1));
      continue;
    }

    const value = args[i + 1];
    if (value == null || value.startsWith("--")) {
      throw new Error(`Missing value for --${withoutPrefix}`);
    }
    values.set(withoutPrefix, value);
    i += 1;
  }
  return values;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

async function postJson<T = unknown>(args: { url: URL; body: unknown }): Promise<T> {
  const response = await fetch(args.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args.body),
  });
  if (!response.ok) {
    throw new Error(
      `POST ${args.url.toString()} failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

async function readStreamEvents(args: {
  eventsBaseUrl: string;
  streamPath: string;
}): Promise<StreamEvent[]> {
  const url = new URL(`/api/streams/${encodeURIComponent(args.streamPath)}`, args.eventsBaseUrl);
  url.searchParams.set("beforeOffset", "end");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `GET ${url.toString()} failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }

  const text = await response.text();
  return parseServerSentEvents(text);
}

function parseServerSentEvents(text: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const parsed = JSON.parse(line.slice("data: ".length)) as unknown;
    if (!isRecord(parsed) || typeof parsed.type !== "string") continue;
    events.push({
      type: parsed.type,
      payload: parsed.payload,
      offset: typeof parsed.offset === "number" ? parsed.offset : undefined,
    });
  }
  return events;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
