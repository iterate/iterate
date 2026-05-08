import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { RouterClient } from "@orpc/server";
import { osContract } from "@iterate-com/os2-contract";
import type { appRouter } from "~/orpc/root.ts";

type TrafficKind = "raw-openai-ws" | "mixed-control" | "agent-chat-responses";
type Publisher = "app-worker" | "agent-durable-object";
type SubscriberMode = "both" | "agent-only" | "codemode-only";
type SubscriptionTransport = "rpc" | "websocket";
type OrpcClient = RouterClient<typeof appRouter>;

type BenchmarkResult = {
  streamDiagnostics: {
    idempotencyCommittedEventCount: number;
    idempotencyDuplicateAttemptCount: number;
    idempotencyLogicalAppendAttemptCount: number;
    idempotencyDuplicateTopKeys: IdempotencyDuplicateKey[];
  };
};

type IdempotencyDuplicateKey = {
  duplicateAttempts: number;
  idempotencyKey: string;
};

type Options = {
  agentPath: string;
  baseUrl: string;
  concurrency: number;
  count: number;
  payloadBytes: number;
  projectSlugOrId: string | null;
  publisher: Publisher;
  ratePerSecond: number;
  allowedIdempotencyDuplicateKeyPrefixes: string[];
  maxIdempotencyDuplicateAttempts: number;
  maxUnexpectedIdempotencyDuplicateAttempts: number;
  subscriberMode: SubscriberMode;
  subscriptionTransport: SubscriptionTransport;
  terminalEvents: boolean;
  traffic: TrafficKind;
};

const DEFAULT_ALLOWED_IDEMPOTENCY_DUPLICATE_KEY_PREFIXES = [
  "agent-default-system-prompt-v2",
  "codemode-session-callable-subscription:",
  "codemode:tool-provider-registered:",
  "events.iterate.com/codemode/session-started",
  "os2-agent-setup:",
  "processor-registered:",
  "stream-processor-callable-subscription:",
  "stream-processor-websocket-subscription:",
];

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const client = createClient(options.baseUrl);
  const projectSlugOrId =
    options.projectSlugOrId ??
    (
      await client.projects.create({
        metadata: { benchmark: "agent-stream-server" },
        slug: `agent-stream-server-${Date.now()}`,
      })
    ).id;

  const result = (await client.project.agents.benchmarkStream({
    agentPath: options.agentPath,
    concurrency: options.concurrency,
    count: options.count,
    payloadBytes: options.payloadBytes,
    projectSlugOrId,
    publisher: options.publisher,
    ratePerSecond: options.ratePerSecond,
    subscriberMode: options.subscriberMode,
    subscriptionTransport: options.subscriptionTransport,
    terminalEvents: options.terminalEvents,
    traffic: options.traffic,
  })) as BenchmarkResult;

  const duplicateInvariant = evaluateIdempotencyDuplicateInvariant({ options, result });
  console.log(
    JSON.stringify(
      {
        options: { ...options, projectSlugOrId },
        duplicateInvariant,
        result,
      },
      null,
      2,
    ),
  );

  if (!duplicateInvariant.passed) {
    throw new Error(
      [
        "Idempotency duplicate invariant failed.",
        `duplicateAttempts=${duplicateInvariant.duplicateAttempts}`,
        `maxDuplicateAttempts=${options.maxIdempotencyDuplicateAttempts}`,
        `unexpectedDuplicateAttempts=${duplicateInvariant.unexpectedDuplicateAttempts}`,
        `maxUnexpectedDuplicateAttempts=${options.maxUnexpectedIdempotencyDuplicateAttempts}`,
      ].join(" "),
    );
  }
}

function createClient(baseUrl: string) {
  const authHeaders = requireAuthHeaders();
  return createORPCClient(
    new OpenAPILink(osContract, {
      url: `${baseUrl}/api`,
      fetch: (input, init) => {
        const requestInit: RequestInit = init ?? {};
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        for (const [key, value] of new Headers(requestInit.headers)) headers.set(key, value);
        for (const [key, value] of Object.entries(authHeaders)) headers.set(key, value);
        if (input instanceof Request) return fetch(new Request(input, { ...requestInit, headers }));
        return fetch(input, { ...requestInit, headers });
      },
    }),
  ) as OrpcClient;
}

function requireAuthHeaders() {
  const bearerToken =
    process.env.OS2_E2E_ADMIN_API_SECRET?.trim() ||
    process.env.OS2_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
    process.env.OS2_E2E_BEARER_TOKEN?.trim();
  const cookie = process.env.OS2_E2E_COOKIE?.trim();
  if (!bearerToken && !cookie) {
    throw new Error(
      "OS2_E2E_ADMIN_API_SECRET, OS2_ADMIN_API_SECRET, APP_CONFIG_ADMIN_API_SECRET, OS2_E2E_BEARER_TOKEN, or OS2_E2E_COOKIE is required.",
    );
  }

  return {
    ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

function parseOptions(args: readonly string[]): Options {
  const values = parseArgs(args);
  const traffic = trafficOption(values, "traffic", "raw-openai-ws");
  return {
    agentPath: stringOption(values, "agent-path", `/agents/server-bench-${Date.now()}`),
    baseUrl: stringOption(values, "base-url", process.env.OS2_BASE_URL ?? ""),
    concurrency: numberOption(values, "concurrency", 100),
    count: numberOption(values, "count", 1000),
    payloadBytes: numberOption(values, "payload-bytes", traffic === "raw-openai-ws" ? 128 : 64),
    projectSlugOrId: optionalStringOption(values, "project"),
    publisher: publisherOption(values, "publisher", "app-worker"),
    ratePerSecond: numberOption(values, "rate", 1000),
    allowedIdempotencyDuplicateKeyPrefixes: stringListOption(
      values,
      "allowed-idempotency-duplicate-key-prefixes",
      DEFAULT_ALLOWED_IDEMPOTENCY_DUPLICATE_KEY_PREFIXES,
    ),
    maxIdempotencyDuplicateAttempts: numberOption(
      values,
      "max-idempotency-duplicate-attempts",
      25,
      { allowZero: true },
    ),
    maxUnexpectedIdempotencyDuplicateAttempts: numberOption(
      values,
      "max-unexpected-idempotency-duplicate-attempts",
      0,
      { allowZero: true },
    ),
    subscriberMode: subscriberModeOption(values, "subscriber-mode", "both"),
    subscriptionTransport: subscriptionTransportOption(values, "subscription-transport", "rpc"),
    terminalEvents: booleanOption(values, "terminal-events", true),
    traffic,
  };
}

function parseArgs(args: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (!arg?.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey ?? "";
    if (!key) throw new Error(`Invalid option: ${arg}`);
    if (inlineValue != null) {
      values.set(key, inlineValue);
      continue;
    }
    const next = args[index + 1];
    if (next == null || next.startsWith("--")) {
      values.set(key, "true");
      continue;
    }
    values.set(key, next);
    index += 1;
  }
  return values;
}

function stringOption(values: Map<string, string>, key: string, fallback: string) {
  const value = values.get(key) ?? fallback;
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function optionalStringOption(values: Map<string, string>, key: string) {
  return values.get(key) ?? null;
}

function numberOption(
  values: Map<string, string>,
  key: string,
  fallback: number,
  options: { allowZero?: boolean } = {},
) {
  const raw = values.get(key);
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || (options.allowZero ? value < 0 : value <= 0)) {
    throw new Error(`--${key} must be ${options.allowZero ? "zero or positive" : "positive"}`);
  }
  return value;
}

function stringListOption(values: Map<string, string>, key: string, fallback: string[]) {
  const raw = values.get(key);
  if (raw == null) return fallback;
  const items = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length === 0) throw new Error(`--${key} must contain at least one value`);
  return items;
}

function booleanOption(values: Map<string, string>, key: string, fallback: boolean) {
  const raw = values.get(key);
  if (raw == null) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`--${key} must be true or false`);
}

function trafficOption(values: Map<string, string>, key: string, fallback: TrafficKind) {
  const value = values.get(key) ?? fallback;
  if (value === "raw-openai-ws" || value === "mixed-control" || value === "agent-chat-responses") {
    return value;
  }
  throw new Error(`--${key} must be raw-openai-ws, mixed-control, or agent-chat-responses`);
}

function publisherOption(values: Map<string, string>, key: string, fallback: Publisher) {
  const value = values.get(key) ?? fallback;
  if (value === "app-worker" || value === "agent-durable-object") return value;
  throw new Error(`--${key} must be app-worker or agent-durable-object`);
}

function subscriberModeOption(values: Map<string, string>, key: string, fallback: SubscriberMode) {
  const value = values.get(key) ?? fallback;
  if (value === "both" || value === "agent-only" || value === "codemode-only") return value;
  throw new Error(`--${key} must be both, agent-only, or codemode-only`);
}

function subscriptionTransportOption(
  values: Map<string, string>,
  key: string,
  fallback: SubscriptionTransport,
) {
  const value = values.get(key) ?? fallback;
  if (value === "rpc" || value === "websocket") return value;
  throw new Error(`--${key} must be rpc or websocket`);
}

function evaluateIdempotencyDuplicateInvariant(input: {
  options: Options;
  result: BenchmarkResult;
}) {
  const duplicateKeys = input.result.streamDiagnostics.idempotencyDuplicateTopKeys;
  const unexpectedKeys = duplicateKeys.filter(
    (key) =>
      !input.options.allowedIdempotencyDuplicateKeyPrefixes.some((prefix) =>
        key.idempotencyKey.startsWith(prefix),
      ),
  );
  const unexpectedDuplicateAttempts = unexpectedKeys.reduce(
    (sum, key) => sum + key.duplicateAttempts,
    0,
  );
  const duplicateAttempts = input.result.streamDiagnostics.idempotencyDuplicateAttemptCount;
  const logicalAppendAttempts = input.result.streamDiagnostics.idempotencyLogicalAppendAttemptCount;
  const committedIdempotentEvents = input.result.streamDiagnostics.idempotencyCommittedEventCount;

  return {
    passed:
      duplicateAttempts <= input.options.maxIdempotencyDuplicateAttempts &&
      unexpectedDuplicateAttempts <= input.options.maxUnexpectedIdempotencyDuplicateAttempts,
    committedIdempotentEvents,
    duplicateAttempts,
    logicalAppendAttempts,
    duplicateAttemptRatio:
      committedIdempotentEvents === 0 ? null : round(duplicateAttempts / committedIdempotentEvents),
    unexpectedDuplicateAttempts,
    unexpectedKeys,
  };
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

await main();
