import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { eventsContract, StreamPath } from "@iterate-com/events-contract";
import { CodemodeEventType } from "./codemode-events.ts";

type EventsClient = ContractRouterClient<typeof eventsContract>;

void main();

async function main() {
  const baseUrl = process.env.EVENTS_BASE_URL?.replace(/\/+$/, "") ?? "https://events.iterate.com";
  const client = createORPCClient(
    new OpenAPILink(eventsContract, {
      url: `${baseUrl}/api`,
    }),
  ) as EventsClient;

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const path = StreamPath.parse(`/codemode-poc/${suffix}`);
  const executionId = `exec_${suffix}`;

  const start = await client.append({
    path,
    event: {
      type: CodemodeEventType.scriptExecutionRequested,
      payload: { executionId, code: "1 + 1" },
    },
  });

  const result = await client.append({
    path,
    event: {
      type: CodemodeEventType.scriptExecutionSucceeded,
      payload: { executionId, result: 2 },
    },
  });

  const streamed = [];
  const stream = await client.stream({
    path,
    afterOffset: start.event.offset - 1,
    beforeOffset: result.event.offset + 1,
  });
  for await (const event of stream) {
    streamed.push(event);
  }

  console.log(
    JSON.stringify(
      {
        baseUrl,
        path,
        start: start.event,
        result: result.event,
        streamed,
      },
      null,
      2,
    ),
  );
}
