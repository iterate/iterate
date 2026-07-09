import { mkdir, writeFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isMainModule } from "@iterate-com/shared/dev/is-main-module";

import { connectItx } from "../src/itx-client.ts";
import type { StreamEvent, StreamEventInput } from "../src/itx-api.generated.ts";
import { readDevServerInfo } from "./lib/dev-server-info.ts";

type Provider = "cloudflare-ai" | "openai-ws";

type Options = {
  agentPrefix: string;
  baseUrl: string;
  cloudflareModel: string;
  listModels: boolean;
  openaiModel: string;
  outputDir: string;
  project: string;
  providers: Provider[];
  rounds: number;
  timeoutMs: number;
  turns: number;
  words: number;
};

type ProjectHandle = Disposable & {
  ai: { models(): Promise<unknown> };
  agents: {
    defaults: {
      forPath(
        path: string,
        overrides: { model: string; provider: Provider; systemPrompt: string },
      ): Promise<{ events: StreamEventInput[] }>;
    };
  };
  streams: { get(path: string): StreamHandle };
};

type StreamHandle = {
  append(...events: StreamEventInput[]): Promise<StreamEvent[]>;
  getEvents(args?: {
    afterOffset?: number;
    eventTypes?: readonly string[];
    limit?: number;
  }): Promise<StreamEvent[]>;
};

type TurnResult = {
  agentPath: string;
  chunkCount: number;
  completionCreatedAt?: string;
  completionPayload?: unknown;
  durationMs?: number;
  endToEndInputToCompletionMs?: number;
  endToEndInputToFirstTextMs?: number;
  endToEndInputToFirstTokenMs?: number;
  error?: string;
  firstFrameMs?: number;
  firstTextChunkMs?: number;
  firstTokenChunkMs?: number;
  inputCreatedAt: string;
  interTextChunkGapsMs: number[];
  interTokenChunkGapsMs: number[];
  llmRequestId?: number;
  model: string;
  outputChars: number;
  outputTextPreview: string;
  outputTokensEstimated: number;
  outputTokensReported?: number;
  provider: Provider;
  providerCompletionMs?: number;
  providerStartCreatedAt?: string;
  providerStartToCompletionMs?: number;
  providerStartToFirstTextMs?: number;
  providerStartToFirstTokenMs?: number;
  reasoningChars: number;
  reasoningTextPreview: string;
  requestId: string;
  round: number;
  status: "failure" | "success" | "timeout";
  textChunkCount: number;
  textChunkGapStatsMs: Stats | null;
  tokenChunkCount: number;
  tokenChunkGapStatsMs: Stats | null;
  tokensPerSecondEstimated?: number;
  tokensPerSecondReported?: number;
  turn: number;
};

type Stats = {
  avg: number;
  max: number;
  median: number;
  min: number;
  p95: number;
};

type SummaryEntry = {
  count: number;
  failures: number;
  firstTextMs: Stats | null;
  firstTokenMs: Stats | null;
  inputToFirstTextMs: Stats | null;
  inputToFirstTokenMs: Stats | null;
  providerCompletionMs: Stats | null;
  reportedTokensPerSecond: Stats | null;
  textChunkGapMs: Stats | null;
  tokenChunkGapMs: Stats | null;
};

type Summary = Record<string, SummaryEntry>;

const DEFAULT_OUTPUT_DIR = ".output/ai-benchmarks";
const DEFAULT_SYSTEM_PROMPT = [
  "You are a latency benchmark target.",
  "Reply in plain text only.",
  "Do not use markdown, code fences, JSON, or tool calls.",
  "For each user message, write the requested number of simple English words about the nonce.",
  "End the answer with the word DONE.",
].join(" ");

export async function main(rawArgs = process.argv.slice(2)) {
  const options = parseArgs(rawArgs);
  using project = connectItx({
    auth: { type: "admin-secret", secret: requireEnv("APP_CONFIG_ADMIN_API_SECRET") },
    baseUrl: options.baseUrl,
    projectId: options.project,
  }) as unknown as ProjectHandle;

  if (options.listModels) {
    const models = await project.ai.models();
    process.stdout.write(`${JSON.stringify(models, null, 2)}\n`);
    return;
  }

  const startedAt = new Date();
  const results: TurnResult[] = [];
  for (const provider of options.providers) {
    for (let round = 1; round <= options.rounds; round += 1) {
      const model = provider === "openai-ws" ? options.openaiModel : options.cloudflareModel;
      const agentPath = `${options.agentPrefix}/${provider}/round-${round}-${Date.now().toString(36)}`;
      process.stderr.write(`[bench] setup ${provider} round ${round} at ${agentPath}\n`);
      await setupAgent({ agentPath, model, project, provider });

      for (let turn = 1; turn <= options.turns; turn += 1) {
        process.stderr.write(`[bench] ${provider} round ${round} turn ${turn}\n`);
        results.push(
          await runTurn({
            agentPath,
            model,
            project,
            provider,
            round,
            timeoutMs: options.timeoutMs,
            turn,
            words: options.words,
          }),
        );
      }
    }
  }

  const finishedAt = new Date();
  const report = {
    finishedAt: finishedAt.toISOString(),
    options,
    results,
    startedAt: startedAt.toISOString(),
    summary: summarize(results),
  };

  await mkdir(options.outputDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const jsonPath = `${options.outputDir}/ai-latency-${stamp}.json`;
  const mdPath = `${options.outputDir}/ai-latency-${stamp}.md`;
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(mdPath, renderMarkdown(report));

  process.stdout.write(
    `${JSON.stringify(
      {
        jsonPath,
        mdPath,
        summary: report.summary,
      },
      null,
      2,
    )}\n`,
  );
}

async function setupAgent(input: {
  agentPath: string;
  model: string;
  project: ProjectHandle;
  provider: Provider;
}) {
  const stream = input.project.streams.get(input.agentPath);
  await stream.getEvents({ limit: 1 });
  await waitForMechanics({ stream, timeoutMs: 60_000 });
  const defaults = await input.project.agents.defaults.forPath(input.agentPath, {
    model: input.model,
    provider: input.provider,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
  });
  await stream.append(...defaults.events);
}

async function waitForMechanics(input: { stream: StreamHandle; timeoutMs: number }) {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const events = await input.stream.getEvents({
      eventTypes: ["events.iterate.com/stream/subscription-configured"],
      limit: 100,
    });
    const text = JSON.stringify(events);
    if (text.includes("#agent") && text.includes("#cloudflare-ai") && text.includes("#openai-ws")) {
      return;
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for agent processor subscriptions.");
}

async function runTurn(input: {
  agentPath: string;
  model: string;
  project: ProjectHandle;
  provider: Provider;
  round: number;
  timeoutMs: number;
  turn: number;
  words: number;
}): Promise<TurnResult> {
  const stream = input.project.streams.get(input.agentPath);
  const nonce = `${input.provider}-r${input.round}-t${input.turn}-${Date.now().toString(36)}`;
  const requestId = `bench:${nonce}`;
  const [messageEvent, scheduledEvent] = await stream.append(
    {
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: `bench/input:${nonce}`,
      payload: {
        content: `Nonce ${nonce}. Produce exactly ${input.words} words, then DONE.`,
        llmRequestPolicy: { behaviour: "after-current-request" },
      },
    },
    {
      type: "events.iterate.com/agent/llm-request-scheduled",
      idempotencyKey: `bench/scheduled:${nonce}`,
      payload: {
        debounceMs: 0,
        model: input.model,
        provider: input.provider,
        requestId,
      },
    },
  );

  const events = await waitForProviderCompletion({
    afterOffset: scheduledEvent.offset,
    provider: input.provider,
    requestId,
    stream,
    timeoutMs: input.timeoutMs,
  });

  return analyzeTurn({
    agentPath: input.agentPath,
    events,
    inputCreatedAt: messageEvent.createdAt,
    model: input.model,
    provider: input.provider,
    requestId,
    round: input.round,
    turn: input.turn,
  });
}

async function waitForProviderCompletion(input: {
  afterOffset: number;
  provider: Provider;
  requestId: string;
  stream: StreamHandle;
  timeoutMs: number;
}) {
  const deadline = Date.now() + input.timeoutMs;
  let llmRequestId: number | undefined;
  let seen: StreamEvent[] = [];
  while (Date.now() < deadline) {
    seen = await getEventsSince(input.stream, input.afterOffset);
    const requested = seen.find(
      (event) =>
        event.type === "events.iterate.com/agent/llm-request-requested" &&
        event.payload?.requestId === input.requestId,
    );
    if (requested) llmRequestId = requested.offset;
    if (llmRequestId !== undefined) {
      const completed = seen.find(
        (event) =>
          event.type === `events.iterate.com/${input.provider}/llm-request-completed` &&
          event.payload?.llmRequestId === llmRequestId,
      );
      if (completed) return seen;
    }
    await sleep(100);
  }
  return seen;
}

async function getEventsSince(stream: StreamHandle, afterOffset: number) {
  const events: StreamEvent[] = [];
  let cursor = afterOffset;
  while (true) {
    const page = await stream.getEvents({ afterOffset: cursor, limit: 500 });
    events.push(...page);
    if (page.length < 500) return events;
    cursor = page.at(-1)!.offset;
  }
}

function analyzeTurn(input: {
  agentPath: string;
  events: StreamEvent[];
  inputCreatedAt: string;
  model: string;
  provider: Provider;
  requestId: string;
  round: number;
  turn: number;
}): TurnResult {
  const requested = input.events.find(
    (event) =>
      event.type === "events.iterate.com/agent/llm-request-requested" &&
      event.payload?.requestId === input.requestId,
  );
  const llmRequestId = requested?.offset;
  const providerPrefix = `events.iterate.com/${input.provider}`;
  const started = input.events.find(
    (event) =>
      event.type === `${providerPrefix}/llm-request-started` &&
      event.payload?.llmRequestId === llmRequestId,
  );
  const chunks = input.events.filter(
    (event) =>
      event.type === `${providerPrefix}/llm-response-chunk` &&
      event.payload?.llmRequestId === llmRequestId,
  );
  const completion = input.events.find(
    (event) =>
      event.type === `${providerPrefix}/llm-request-completed` &&
      event.payload?.llmRequestId === llmRequestId,
  );
  const completionPayload = completion?.payload;
  const result = completionPayload?.result as
    | { error?: { message?: string }; status?: "failure" | "success"; usage?: unknown }
    | undefined;
  const streamChunks = chunks
    .map((event) => ({ event, delta: extractStreamDelta(input.provider, event.payload?.chunk) }))
    .filter((chunk) => chunk.delta.text.length > 0);
  const textChunks = streamChunks.filter((chunk) => chunk.delta.kind === "answer");
  const reasoningChunks = streamChunks.filter((chunk) => chunk.delta.kind === "reasoning");
  const outputText = textChunks.map((chunk) => chunk.delta.text).join("");
  const reasoningText = reasoningChunks.map((chunk) => chunk.delta.text).join("");
  const firstFrameMs =
    started && chunks[0] ? diffMs(started.createdAt, chunks[0].createdAt) : undefined;
  const firstTextChunkMs =
    started && textChunks[0] ? diffMs(started.createdAt, textChunks[0].event.createdAt) : undefined;
  const firstTokenChunkMs =
    started && streamChunks[0]
      ? diffMs(started.createdAt, streamChunks[0].event.createdAt)
      : undefined;
  const completionMs =
    started && completion ? diffMs(started.createdAt, completion.createdAt) : undefined;
  const inputToFirstText =
    textChunks[0] === undefined
      ? undefined
      : diffMs(input.inputCreatedAt, textChunks[0].event.createdAt);
  const inputToFirstToken =
    streamChunks[0] === undefined
      ? undefined
      : diffMs(input.inputCreatedAt, streamChunks[0].event.createdAt);
  const inputToCompletion =
    completion === undefined ? undefined : diffMs(input.inputCreatedAt, completion.createdAt);
  const gaps = pairwiseGaps(textChunks.map((chunk) => chunk.event.createdAt));
  const tokenGaps = pairwiseGaps(streamChunks.map((chunk) => chunk.event.createdAt));
  const reportedTokens = extractOutputTokenCount(result?.usage ?? completionPayload);
  const estimatedTokens = estimateTokens(outputText);
  const generationSeconds = completionMs === undefined ? undefined : completionMs / 1000;

  return {
    agentPath: input.agentPath,
    chunkCount: chunks.length,
    ...(completion === undefined ? {} : { completionCreatedAt: completion.createdAt }),
    ...(completionPayload === undefined ? {} : { completionPayload }),
    ...(completionPayload?.durationMs === undefined
      ? {}
      : { durationMs: Number(completionPayload.durationMs) }),
    ...(inputToCompletion === undefined ? {} : { endToEndInputToCompletionMs: inputToCompletion }),
    ...(inputToFirstText === undefined ? {} : { endToEndInputToFirstTextMs: inputToFirstText }),
    ...(inputToFirstToken === undefined ? {} : { endToEndInputToFirstTokenMs: inputToFirstToken }),
    ...(result?.status === "failure" ? { error: result.error?.message ?? "provider failure" } : {}),
    ...(firstFrameMs === undefined ? {} : { firstFrameMs }),
    ...(firstTextChunkMs === undefined ? {} : { firstTextChunkMs }),
    ...(firstTokenChunkMs === undefined ? {} : { firstTokenChunkMs }),
    inputCreatedAt: input.inputCreatedAt,
    interTextChunkGapsMs: gaps,
    interTokenChunkGapsMs: tokenGaps,
    ...(llmRequestId === undefined ? {} : { llmRequestId }),
    model: input.model,
    outputChars: outputText.length,
    outputTextPreview: outputText.slice(0, 500),
    outputTokensEstimated: estimatedTokens,
    ...(reportedTokens === undefined ? {} : { outputTokensReported: reportedTokens }),
    provider: input.provider,
    ...(completionMs === undefined ? {} : { providerCompletionMs: completionMs }),
    ...(started === undefined ? {} : { providerStartCreatedAt: started.createdAt }),
    ...(completionMs === undefined ? {} : { providerStartToCompletionMs: completionMs }),
    ...(firstTextChunkMs === undefined ? {} : { providerStartToFirstTextMs: firstTextChunkMs }),
    ...(firstTokenChunkMs === undefined ? {} : { providerStartToFirstTokenMs: firstTokenChunkMs }),
    reasoningChars: reasoningText.length,
    reasoningTextPreview: reasoningText.slice(0, 500),
    requestId: input.requestId,
    round: input.round,
    status:
      completion === undefined ? "timeout" : result?.status === "failure" ? "failure" : "success",
    textChunkCount: textChunks.length,
    textChunkGapStatsMs: stats(gaps),
    tokenChunkCount: streamChunks.length,
    tokenChunkGapStatsMs: stats(tokenGaps),
    ...(generationSeconds === undefined || generationSeconds <= 0
      ? {}
      : {
          tokensPerSecondEstimated: estimatedTokens / generationSeconds,
          ...(reportedTokens === undefined
            ? {}
            : { tokensPerSecondReported: reportedTokens / generationSeconds }),
        }),
    turn: input.turn,
  };
}

function extractStreamDelta(
  provider: Provider,
  chunk: unknown,
): { kind: "answer" | "reasoning"; text: string } {
  if (provider === "openai-ws") {
    if (
      isRecord(chunk) &&
      chunk.type === "response.output_text.delta" &&
      typeof chunk.delta === "string"
    ) {
      return { kind: "answer", text: chunk.delta };
    }
    if (
      isRecord(chunk) &&
      typeof chunk.delta === "string" &&
      typeof chunk.type === "string" &&
      chunk.type.includes("reasoning")
    ) {
      return { kind: "reasoning", text: chunk.delta };
    }
    return { kind: "answer", text: "" };
  }
  if (typeof chunk === "string") return { kind: "answer", text: chunk };
  if (!isRecord(chunk)) return { kind: "answer", text: "" };
  if (typeof chunk.response === "string") return { kind: "answer", text: chunk.response };
  const choices = chunk.choices;
  if (Array.isArray(choices) && choices.length > 0 && isRecord(choices[0])) {
    const delta = choices[0].delta;
    if (isRecord(delta)) {
      if (typeof delta.content === "string" && delta.content.length > 0) {
        return { kind: "answer", text: delta.content };
      }
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        return { kind: "reasoning", text: delta.reasoning_content };
      }
      if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
        return { kind: "reasoning", text: delta.reasoning };
      }
    }
  }
  const delta = chunk.delta;
  if (isRecord(delta) && typeof delta.text === "string")
    return { kind: "answer", text: delta.text };
  return { kind: "answer", text: "" };
}

function extractOutputTokenCount(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of [
    "output_tokens",
    "completion_tokens",
    "generated_tokens",
    "completionTokens",
  ]) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  const output = value.output;
  if (isRecord(output) && typeof output.tokens === "number") return output.tokens;
  const completion = value.completion;
  if (isRecord(completion) && typeof completion.tokens === "number") return completion.tokens;
  const usage = value.usage;
  if (usage !== value) return extractOutputTokenCount(usage);
  return undefined;
}

function summarize(results: TurnResult[]): Summary {
  const groups = new Map<string, TurnResult[]>();
  for (const result of results) {
    for (const key of [result.provider, `${result.provider}:turn-${result.turn}`]) {
      groups.set(key, [...(groups.get(key) ?? []), result]);
    }
  }
  return Object.fromEntries(
    [...groups.entries()].map(([key, group]) => {
      const successes = group.filter((result) => result.status === "success");
      return [
        key,
        {
          count: group.length,
          failures: group.filter((result) => result.status !== "success").length,
          firstTextMs: stats(compact(successes.map((result) => result.providerStartToFirstTextMs))),
          firstTokenMs: stats(
            compact(successes.map((result) => result.providerStartToFirstTokenMs)),
          ),
          inputToFirstTextMs: stats(
            compact(successes.map((result) => result.endToEndInputToFirstTextMs)),
          ),
          inputToFirstTokenMs: stats(
            compact(successes.map((result) => result.endToEndInputToFirstTokenMs)),
          ),
          providerCompletionMs: stats(
            compact(successes.map((result) => result.providerStartToCompletionMs)),
          ),
          reportedTokensPerSecond: stats(
            compact(successes.map((result) => result.tokensPerSecondReported)),
          ),
          textChunkGapMs: stats(successes.flatMap((result) => result.interTextChunkGapsMs)),
          tokenChunkGapMs: stats(successes.flatMap((result) => result.interTokenChunkGapsMs)),
        },
      ];
    }),
  ) as Summary;
}

function renderMarkdown(report: {
  finishedAt: string;
  options: Options;
  results: TurnResult[];
  startedAt: string;
  summary: Summary;
}) {
  const lines = [
    "# AI Latency Benchmark",
    "",
    `Started: ${report.startedAt}`,
    `Finished: ${report.finishedAt}`,
    `Project: ${report.options.project}`,
    `Providers: ${report.options.providers.join(", ")}`,
    `Models: cloudflare-ai=${report.options.cloudflareModel}, openai-ws=${report.options.openaiModel}`,
    "",
    "Notes:",
    "- First token is measured from the provider processor's started event to the first streamed answer or reasoning token.",
    "- First text is measured from the provider processor's started event to the first streamed final-answer text token.",
    "- End-to-end first token/text is measured from the input event commit and includes the agent scheduling append.",
    "- Reported tokens/sec uses provider usage when present; estimated tokens use output characters / 4.",
    "",
    "## Summary",
    "",
    "| Group | n | failures | first token p50/p95 ms | first text p50/p95 ms | provider complete p50/p95 ms | token gap p50/p95 ms | reported tok/s p50 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [key, summary] of Object.entries(report.summary)) {
    lines.push(
      `| ${key} | ${summary.count} | ${summary.failures} | ${fmtPair(summary.firstTokenMs)} | ${fmtPair(summary.firstTextMs)} | ${fmtPair(summary.providerCompletionMs)} | ${fmtPair(summary.tokenChunkGapMs)} | ${fmt(summary.reportedTokensPerSecond?.median)} |`,
    );
  }
  lines.push("", "## Runs", "");
  lines.push(
    "| Provider | Round | Turn | Status | first token ms | first text ms | complete ms | chunks | token chunks | text chunks | reasoning chars | reported tok/s | est tok/s | chars |",
  );
  lines.push(
    "| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const result of report.results) {
    lines.push(
      `| ${result.provider} | ${result.round} | ${result.turn} | ${result.status} | ${fmt(result.providerStartToFirstTokenMs)} | ${fmt(result.providerStartToFirstTextMs)} | ${fmt(result.providerStartToCompletionMs)} | ${result.chunkCount} | ${result.tokenChunkCount} | ${result.textChunkCount} | ${result.reasoningChars} | ${fmt(result.tokensPerSecondReported)} | ${fmt(result.tokensPerSecondEstimated)} | ${result.outputChars} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function parseArgs(args: string[]): Options {
  const options: Partial<Options> = {
    agentPrefix: "/agents/benchmarks/ai-latency",
    cloudflareModel: "openai/gpt-5.5",
    listModels: false,
    openaiModel: "gpt-5.5",
    outputDir: DEFAULT_OUTPUT_DIR,
    providers: ["cloudflare-ai", "openai-ws"],
    rounds: 5,
    timeoutMs: 180_000,
    turns: 3,
    words: 120,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = () => {
      const next = args[++index];
      if (next === undefined) throw new Error(`Missing value for ${arg}`);
      return next;
    };
    switch (arg) {
      case "--agent-prefix":
        options.agentPrefix = normalizeAgentPrefix(value());
        break;
      case "--base-url":
        options.baseUrl = stripTrailingSlash(value());
        break;
      case "--cloudflare-model":
        options.cloudflareModel = value();
        break;
      case "--list-models":
        options.listModels = true;
        break;
      case "--openai-model":
        options.openaiModel = value();
        break;
      case "--output-dir":
        options.outputDir = value();
        break;
      case "--project":
        options.project = value();
        break;
      case "--providers":
        options.providers = parseProviders(value());
        break;
      case "--rounds":
        options.rounds = parsePositiveInt(arg, value());
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInt(arg, value());
        break;
      case "--turns":
        options.turns = parsePositiveInt(arg, value());
        break;
      case "--words":
        options.words = parsePositiveInt(arg, value());
        break;
      case "-h":
      case "--help":
        process.stdout.write(helpText());
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}\n\n${helpText()}`);
    }
  }
  options.baseUrl ??= defaultBaseUrl();
  if (!options.project) throw new Error("--project is required.");
  return options as Options;
}

function defaultBaseUrl() {
  const envBase = process.env.APP_CONFIG_BASE_URL?.trim();
  if (envBase) return stripTrailingSlash(envBase);
  const local = readDevServerInfo(new URL("..", import.meta.url).pathname, {
    requireLive: true,
  })?.baseUrl;
  if (local) return stripTrailingSlash(local);
  throw new Error("No base URL: pass --base-url, set APP_CONFIG_BASE_URL, or start local dev.");
}

function parseProviders(value: string): Provider[] {
  const providers = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (providers.length === 0) throw new Error("--providers must not be empty.");
  for (const provider of providers) {
    if (provider !== "cloudflare-ai" && provider !== "openai-ws") {
      throw new Error(`Unknown provider: ${provider}`);
    }
  }
  return providers as Provider[];
}

function normalizeAgentPrefix(value: string) {
  const trimmed = stripTrailingSlash(value.trim());
  if (!trimmed.startsWith("/agents/")) throw new Error("--agent-prefix must start with /agents/");
  return trimmed;
}

function parsePositiveInt(name: string, value: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function helpText() {
  return [
    "Usage: tsx scripts/benchmark-ai-latency.ts --project <projectId> [options]",
    "",
    "Options:",
    "  --providers cloudflare-ai,openai-ws",
    "  --cloudflare-model <model>  Default: openai/gpt-5.5",
    "  --openai-model <model>      Default: gpt-5.5",
    "  --rounds <n>                Default: 5",
    "  --turns <n>                 Default: 3",
    "  --words <n>                 Default: 120",
    "  --timeout-ms <n>            Default: 180000",
    "  --base-url <url>            Default: APP_CONFIG_BASE_URL or local dev",
    "  --output-dir <path>         Default: .output/ai-benchmarks",
    "  --list-models               Print itx.ai.models() and exit",
    "",
  ].join("\n");
}

function stats(values: number[]): Stats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    avg: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    max: sorted.at(-1)!,
    median: percentile(sorted, 0.5),
    min: sorted[0]!,
    p95: percentile(sorted, 0.95),
  };
}

function percentile(sorted: number[], quantile: number) {
  if (sorted.length === 1) return sorted[0]!;
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function compact(values: Array<number | undefined>) {
  return values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
}

function pairwiseGaps(createdAts: string[]) {
  const gaps: number[] = [];
  for (let index = 1; index < createdAts.length; index += 1) {
    gaps.push(diffMs(createdAts[index - 1]!, createdAts[index]!));
  }
  return gaps;
}

function diffMs(start: string, end: string) {
  return Date.parse(end) - Date.parse(start);
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function fmt(value: number | undefined | null) {
  return value === undefined || value === null ? "" : value.toFixed(1);
}

function fmtPair(value: Stats | null | undefined) {
  return value ? `${fmt(value.median)} / ${fmt(value.p95)}` : "";
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
