import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { Event } from "@iterate-com/events-contract";
import { eventsContract } from "@iterate-com/events-contract";
import { collectAsyncIterableUntilIdle } from "../e2e/helpers.ts";
import { iterateProjectHeader } from "../src/lib/project-slug.ts";
import { buildDynamicWorkerConfiguredEvent } from "../src/durable-objects/dynamic-worker-bundler.ts";

const baseUrl = process.env.EVENTS_BASE_URL?.trim() ?? "http://localhost:5173";
const openaiKey = process.env.OPENAI_API_KEY;
const projectSlug = "test";
const proofProcessorEntryFile = fileURLToPath(
  new URL("./examples/simple-openai-loop.processor.ts", import.meta.url),
);

if (!openaiKey) {
  throw new Error("OPENAI_API_KEY is required");
}

const client = createORPCClient(
  new OpenAPILink(eventsContract, {
    url: new URL("/api", baseUrl).toString(),
    fetch: (request, init) => {
      const requestInit = init as RequestInit | undefined;
      const headers = new Headers(
        request instanceof Request ? request.headers : requestInit?.headers,
      );
      headers.set(iterateProjectHeader, projectSlug);
      return fetch(request, { ...requestInit, headers });
    },
  }),
) as ContractRouterClient<typeof eventsContract>;

async function main() {
  const path = `/dynamic-worker-openai-proof/${randomUUID().slice(0, 8)}` as const;
  let secretId: string | undefined;
  const configuredEvent = await buildDynamicWorkerConfiguredEvent({
    entryFile: proofProcessorEntryFile,
    outboundGateway: {
      entrypoint: "DynamicWorkerEgressGateway",
      props: {
        secretHeaderName: "authorization",
        secretHeaderValue: `Bearer ${openaiKey}`,
      },
    },
    slug: "simple-openai-loop",
  });
  const bundledScript = configuredEvent.payload.script;

  if (bundledScript == null) {
    throw new Error("Bundler returned a configured event without payload.script");
  }

  try {
    const secret = await client.secrets.create({
      name: `openai-processor-${randomUUID().slice(0, 8)}`,
      value: bundledScript,
      description: "Temporary proof secret for dynamic OpenAI processor bundle",
    });
    secretId = secret.id;
    const storedSecretId = secret.id;

    const storedScript = (await client.secrets.find({ id: secret.id })).value;

    await client.append({
      path,
      event: {
        type: configuredEvent.type,
        payload: {
          ...configuredEvent.payload,
          script: storedScript,
        },
      },
    });

    await client.append({
      path,
      event: {
        type: "llm-input-added",
        payload: {
          content: "Reply with a one sentence greeting.",
        },
      },
    });

    const outputEvent = await waitForEvent(path, "llm-output-added");
    const output = String((outputEvent.payload as { content?: string } | undefined)?.content ?? "");

    if (output.length === 0) {
      throw new Error("llm-output-added was appended without payload.content");
    }

    if (!/pineapple/i.test(output)) {
      throw new Error(`Expected LLM output to mention pineapple once; got: ${output}`);
    }

    const history = await collectHistory(path);

    console.log(
      JSON.stringify(
        {
          ok: true,
          path,
          secretId: storedSecretId,
          eventTypes: history.map((event) => event.type),
          llmOutputPreview: output.slice(0, 160),
        },
        null,
        2,
      ),
    );
  } finally {
    if (secretId != null) {
      await client.secrets.remove({ id: secretId });
    }
    await client.destroy({
      params: { path },
      query: {},
    });
  }
}

async function waitForEvent(path: string, type: string) {
  const deadline = Date.now() + 90_000;

  while (Date.now() < deadline) {
    const history = await collectHistory(path);
    const match = history.find((event) => event.type === type);
    if (match) {
      return match;
    }

    await delay(1_000);
  }

  throw new Error(`Timed out waiting for ${type}`);
}

async function collectHistory(path: string) {
  return (await collectAsyncIterableUntilIdle({
    iterable: await client.stream({ path, live: false }),
    idleMs: 500,
  })) as Event[];
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
