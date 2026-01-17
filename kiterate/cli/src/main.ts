#!/usr/bin/env node
/**
 * kiterate CLI - interact with kiterate event streams
 *
 * Commands:
 *   append <stream> <data>     Append JSON data to a stream
 *   subscribe <stream>         Subscribe to a stream (SSE)
 *   list                       List all streams
 *   get <stream>               Get events from a stream
 */

import { EventSource } from "eventsource";

const BASE_URL = process.env.KITERATE_URL ?? "http://localhost:3456";

async function append(stream: string, data: string): Promise<void> {
  let parsedData: unknown;
  try {
    parsedData = JSON.parse(data);
  } catch {
    // Treat as plain string if not valid JSON
    parsedData = data;
  }

  const response = await fetch(`${BASE_URL}/streams/${stream}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: parsedData }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`Error: ${error}`);
    process.exit(1);
  }

  const result = (await response.json()) as { event: { offset: string; data: unknown } };
  console.log(`Event appended at offset ${result.event.offset}`);
}

async function subscribe(stream: string, offset?: string): Promise<void> {
  const url = offset
    ? `${BASE_URL}/streams/${stream}/subscribe?offset=${offset}`
    : `${BASE_URL}/streams/${stream}/subscribe`;

  console.log(`Subscribing to ${stream}${offset ? ` from offset ${offset}` : ""}...`);

  const eventSource = new EventSource(url);

  eventSource.addEventListener("event", (e: MessageEvent) => {
    try {
      const event = JSON.parse(e.data) as {
        offset: string;
        eventStreamId: string;
        data: unknown;
        createdAt: string;
      };
      console.log(`[${event.offset}] ${JSON.stringify(event.data)}`);
    } catch {
      console.log(`Raw: ${e.data}`);
    }
  });

  eventSource.onerror = (err: Event) => {
    console.error("Connection error:", err);
  };

  // Keep running until interrupted
  process.on("SIGINT", () => {
    eventSource.close();
    console.log("\nDisconnected");
    process.exit(0);
  });
}

async function list(): Promise<void> {
  const response = await fetch(`${BASE_URL}/streams`);

  if (!response.ok) {
    const error = await response.text();
    console.error(`Error: ${error}`);
    process.exit(1);
  }

  const result = (await response.json()) as { streams: string[] };

  if (result.streams.length === 0) {
    console.log("No streams found");
    return;
  }

  console.log("Streams:");
  for (const stream of result.streams) {
    console.log(`  - ${stream}`);
  }
}

async function get(stream: string, offset?: string, limit?: number): Promise<void> {
  const params = new URLSearchParams();
  if (offset) params.set("offset", offset);
  if (limit) params.set("limit", String(limit));

  const url = `${BASE_URL}/streams/${stream}/events${params.toString() ? `?${params}` : ""}`;
  const response = await fetch(url);

  if (!response.ok) {
    const error = await response.text();
    console.error(`Error: ${error}`);
    process.exit(1);
  }

  const result = (await response.json()) as {
    events: Array<{ offset: string; data: unknown; createdAt: string }>;
  };

  if (result.events.length === 0) {
    console.log("No events found");
    return;
  }

  for (const event of result.events) {
    console.log(`[${event.offset}] ${JSON.stringify(event.data)}`);
  }
}

async function deleteStream(stream: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/streams/${stream}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`Error: ${error}`);
    process.exit(1);
  }

  console.log(`Stream ${stream} deleted`);
}

function printUsage(): void {
  console.log(`
kiterate CLI - interact with kiterate event streams

Usage:
  kiterate append <stream> <data>              Append JSON data to a stream
  kiterate subscribe <stream> [--offset=N]    Subscribe to a stream (with optional catchup)
  kiterate list                               List all streams
  kiterate get <stream> [--offset=N] [--limit=N]  Get events from a stream
  kiterate delete <stream>                    Delete a stream

Environment:
  KITERATE_URL    Server URL (default: http://localhost:3456)

Examples:
  kiterate append mystream '{"hello":"world"}'
  kiterate subscribe mystream
  kiterate subscribe mystream --offset=0000000000000005
  kiterate list
  kiterate get mystream --limit=10
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    process.exit(0);
  }

  try {
    switch (command) {
      case "append": {
        const stream = args[1];
        const data = args[2];
        if (!stream || !data) {
          console.error("Usage: kiterate append <stream> <data>");
          process.exit(1);
        }
        await append(stream, data);
        break;
      }

      case "subscribe": {
        const stream = args[1];
        if (!stream) {
          console.error("Usage: kiterate subscribe <stream> [--offset=N]");
          process.exit(1);
        }
        const offsetArg = args.find((a) => a.startsWith("--offset="));
        const offset = offsetArg?.split("=")[1];
        await subscribe(stream, offset);
        break;
      }

      case "list": {
        await list();
        break;
      }

      case "get": {
        const stream = args[1];
        if (!stream) {
          console.error("Usage: kiterate get <stream> [--offset=N] [--limit=N]");
          process.exit(1);
        }
        const offsetArg = args.find((a) => a.startsWith("--offset="));
        const limitArg = args.find((a) => a.startsWith("--limit="));
        const offset = offsetArg?.split("=")[1];
        const limit = limitArg ? parseInt(limitArg.split("=")[1]!, 10) : undefined;
        await get(stream, offset, limit);
        break;
      }

      case "delete": {
        const stream = args[1];
        if (!stream) {
          console.error("Usage: kiterate delete <stream>");
          process.exit(1);
        }
        await deleteStream(stream);
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Error: ${error}`);
    }
    process.exit(1);
  }
}

main();
