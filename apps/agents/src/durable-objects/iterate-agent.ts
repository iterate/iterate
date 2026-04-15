import { DynamicWorkerExecutor, type ResolvedProvider } from "@cloudflare/codemode";
import { resolveProvider } from "@cloudflare/codemode/ai";
import {
  EventInput,
  StreamSocketAppendFrame,
  StreamSocketFrame,
  type EventInput as EventInputValue,
} from "@iterate-com/events-contract";
import { Agent, type Connection, type WSMessage } from "agents";
import { createMcpToolProviders } from "~/lib/mcp-tool-providers.ts";
import { createOpenApiToolProvider } from "~/lib/openapi-tool-provider.ts";
import type { CloudflareEnv } from "~/lib/worker-env.d.ts";

const eventsProviderPromise = createOpenApiToolProvider({
  name: "events",
  spec: "https://events.iterate.com/api/openapi.json",
  request: async ({ method, path, query, body, contentType }) => {
    const url = new URL(path.replace(/^\/+/, ""), "https://events.iterate.com/api/");

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value != null) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      method,
      headers: contentType ? { "content-type": contentType } : undefined,
      body: body == null ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${url}`);
    }

    const responseContentType = response.headers.get("content-type") ?? "";
    return responseContentType.includes("application/json")
      ? await response.json()
      : await response.text();
  },
}).then(resolveProvider) satisfies Promise<ResolvedProvider>;

export class IterateAgent extends Agent<CloudflareEnv> {
  async onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;

    const frame = readEventFrame(message);
    const payload = frame?.event.type === "codemode-block-added" ? frame.event.payload : null;
    const script =
      payload &&
      typeof payload === "object" &&
      "script" in payload &&
      typeof payload.script === "string"
        ? payload.script
        : null;
    if (!script) return;

    const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER });
    const mcpProviders = await createMcpToolProviders({ mcp: this.mcp });
    const result = await executor.execute(script, [
      {
        name: "builtin",
        fns: {
          append: async (event: unknown) => {
            connection.send(
              JSON.stringify(
                StreamSocketAppendFrame.parse({
                  type: "append",
                  event: EventInput.parse(event),
                }),
              ),
            );
            return null;
          },
        },
      },
      await eventsProviderPromise,
      ...mcpProviders.map(resolveProvider),
    ]);

    connection.send(
      JSON.stringify(
        StreamSocketAppendFrame.parse({
          type: "append",
          event: {
            type: "codemode-result-added",
            payload: {
              result: result.result ?? null,
              error: result.error ?? null,
              logs: result.logs ?? [],
            },
          } satisfies EventInputValue,
        }),
      ),
    );
  }
}

function readEventFrame(message: string) {
  try {
    const frame = StreamSocketFrame.parse(JSON.parse(message));
    return frame.type === "event" ? frame : null;
  } catch {
    return null;
  }
}
