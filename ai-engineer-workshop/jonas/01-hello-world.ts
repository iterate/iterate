/**
 * Same behavior as `apps/events/scripts/demo/router.ts` → `hello-world`, but with
 * fixed inputs (no prompts). Adjust the constants below, then run:
 *   pnpm tsx 01-hello-world.ts
 */
import process from "node:process";
import type { ContractRouterClient } from "@orpc/contract";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { eventsContract, type StreamPath } from "@iterate-com/events-contract";

// --- inputs (edit these) ---
const BASE_URL = "https://prd-events.iterate.workers.dev";
const STREAM_PATH = "/";
const HELLO_WORLD_TYPE = "https://events.iterate.com/demo/hello-world-appended";

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

async function main() {
  const baseUrl = normalizeBaseUrl(BASE_URL);
  const streamPath = normalizeStreamPath(STREAM_PATH);

  const client = createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", baseUrl).toString(),
    }),
  ) as ContractRouterClient<typeof eventsContract>;

  const result = await client.append({
    path: streamPath,
    events: [
      {
        path: streamPath,
        type: HELLO_WORLD_TYPE,
        payload: {
          message: "hello world",
        },
      },
    ],
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
