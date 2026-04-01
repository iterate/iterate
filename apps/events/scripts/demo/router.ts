import { createInterface } from "node:readline/promises";
import process from "node:process";
import type { ContractRouterClient } from "@orpc/contract";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { os } from "@orpc/server";
import { eventsContract, type StreamPath } from "@iterate-com/events-contract";
import { z } from "zod";

const DEFAULT_BASE_URL = "https://prd-events.iterate.workers.dev";
const DEFAULT_STREAM_PATH: StreamPath = "/";
const HELLO_WORLD_TYPE = "https://events.iterate.com/demo/hello-world-appended";

const HelloWorldInput = z
  .object({
    streamPath: z.string().trim().min(1).optional().describe("Stream path to append to"),
    baseUrl: z.string().trim().url().optional().describe("Events2 base URL"),
  })
  .default({});

export const router = {
  "hello-world": os
    .input(HelloWorldInput)
    .meta({
      description: "Append a hello world event to a stream",
      default: true,
    })
    .handler(async ({ input }) => {
      const resolved = await resolveInput(input);
      const client = createORPCClient(
        new OpenAPILink(eventsContract, {
          url: new URL("/api", resolved.baseUrl).toString(),
        }),
      ) as ContractRouterClient<typeof eventsContract>;

      return await client.append({
        path: resolved.streamPath,
        type: HELLO_WORLD_TYPE,
        payload: {
          message: "hello world",
        },
      });
    }),
};

async function resolveInput(input: z.infer<typeof HelloWorldInput>) {
  const streamPath = normalizeStreamPath(await resolveStreamPath(input.streamPath));
  const baseUrl = await resolveBaseUrl(input.baseUrl);

  return {
    streamPath,
    baseUrl,
  };
}

async function resolveStreamPath(streamPath: string | undefined) {
  if (streamPath?.trim()) {
    return streamPath.trim();
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const value = (await readline.question(`streamPath [${DEFAULT_STREAM_PATH}]: `)).trim();
    return value.length > 0 ? value : DEFAULT_STREAM_PATH;
  } finally {
    readline.close();
  }
}

async function resolveBaseUrl(baseUrl: string | undefined) {
  if (baseUrl?.trim()) {
    return normalizeBaseUrl(baseUrl);
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const value = (await readline.question(`baseUrl [${DEFAULT_BASE_URL}]: `)).trim();
    return normalizeBaseUrl(value.length > 0 ? value : DEFAULT_BASE_URL);
  } finally {
    readline.close();
  }
}

function normalizeStreamPath(value: string): StreamPath {
  const trimmed = value.trim();

  if (trimmed === "/") {
    return trimmed;
  }

  const normalized = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
  return `/${normalized}`;
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}
