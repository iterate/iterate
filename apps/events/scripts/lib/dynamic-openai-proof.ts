import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { Event } from "@iterate-com/events-contract";
import { eventsContract } from "@iterate-com/events-contract";
import { collectAsyncIterableUntilIdle } from "../../e2e/helpers.ts";
import { iterateProjectHeader } from "../../src/lib/project-slug.ts";
import { buildDynamicWorkerConfiguredEvent } from "../../src/durable-objects/dynamic-worker-bundler.ts";

const exampleProcessorEntryFile = fileURLToPath(
  new URL("../examples/simple-openai-loop.processor.ts", import.meta.url),
);

type EventsClient = ContractRouterClient<typeof eventsContract>;

export async function runDynamicOpenAiProof(args: {
  baseUrl: string;
  openAiApiKey: string;
  projectSlug?: string;
  prompt: string;
  responseTimeoutMs?: number;
}) {
  const client = createEventsClient({
    baseUrl: args.baseUrl,
    projectSlug: args.projectSlug ?? "test",
  });
  const path = `/dynamic-worker-openai-proof/${randomUUID().slice(0, 8)}` as const;
  const openAiSecretName = `dynamic_worker_openai_api_key_${randomUUID().slice(0, 8)}`;
  const responseTimeoutMs = args.responseTimeoutMs ?? 10_000;
  const temporaryProcessorEntryFile = join(
    dirname(exampleProcessorEntryFile),
    `.dynamic-openai-proof-${randomUUID().slice(0, 8)}.processor.ts`,
  );
  let openAiSecretId: string | undefined;

  try {
    const exampleSource = await readFile(exampleProcessorEntryFile, "utf8");
    const temporarySource = exampleSource.replaceAll(
      "dynamic_worker_openai_api_key",
      openAiSecretName,
    );

    if (temporarySource === exampleSource) {
      throw new Error("Failed to customize the example processor secret key for the proof run.");
    }

    await writeFile(temporaryProcessorEntryFile, temporarySource);

    const configuredEvent = await buildDynamicWorkerConfiguredEvent({
      entryFile: temporaryProcessorEntryFile,
      outboundGateway: {
        entrypoint: "DynamicWorkerEgressGateway",
      },
      slug: "simple-openai-loop",
    });
    const bundledScript = configuredEvent.payload.script;

    if (bundledScript == null) {
      throw new Error("Bundler returned a configured event without payload.script");
    }

    const openAiSecret = await client.secrets.create({
      name: openAiSecretName,
      value: args.openAiApiKey,
      description: "Temporary OpenAI API key for dynamic worker proof",
    });
    openAiSecretId = openAiSecret.id;

    await client.append({
      path,
      event: {
        type: configuredEvent.type,
        payload: {
          ...configuredEvent.payload,
          script: bundledScript,
        },
      },
    });

    const startedAt = Date.now();

    await client.append({
      path,
      event: {
        type: "agent-input-added",
        payload: {
          content: args.prompt,
        },
      },
    });

    const outputEvent = await waitForEvent({
      client,
      path,
      timeoutMs: responseTimeoutMs,
      type: "agent-output-added",
    });
    const output = String((outputEvent.payload as { content?: string } | undefined)?.content ?? "");

    if (output.length === 0) {
      throw new Error("agent-output-added was appended without payload.content");
    }

    const history = await collectHistory(client, path);

    return {
      elapsedMs: Date.now() - startedAt,
      eventTypes: history.map((event) => event.type),
      openAiSecretName,
      output,
      path,
    };
  } finally {
    await rm(temporaryProcessorEntryFile, { force: true });

    if (openAiSecretId != null) {
      await client.secrets.remove({ id: openAiSecretId });
    }

    await client.destroy({
      params: { path },
      query: {},
    });
  }
}

function createEventsClient(args: { baseUrl: string; projectSlug: string }) {
  return createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", args.baseUrl).toString(),
      fetch: (request, init) => {
        const requestInit = init as RequestInit | undefined;
        const headers = new Headers(
          request instanceof Request ? request.headers : requestInit?.headers,
        );
        headers.set(iterateProjectHeader, args.projectSlug);
        return fetch(request, { ...requestInit, headers });
      },
    }),
  ) as EventsClient;
}

async function waitForEvent(args: {
  client: EventsClient;
  path: string;
  timeoutMs: number;
  type: string;
}) {
  const deadline = Date.now() + args.timeoutMs;

  while (Date.now() < deadline) {
    const history = await collectHistory(args.client, args.path);
    const match = history.find((event) => event.type === args.type);

    if (match != null) {
      return match;
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for ${args.type} after ${args.timeoutMs}ms`);
}

async function collectHistory(client: EventsClient, path: string) {
  return (await collectAsyncIterableUntilIdle({
    iterable: (await client.stream({ path, before: "end" })) as AsyncIterable<Event>,
    idleMs: 500,
  })) as Event[];
}
