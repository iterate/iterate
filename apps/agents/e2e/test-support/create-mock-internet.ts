import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { ProjectSlug } from "@iterate-com/events-contract";
import {
  fromTrafficWithWebSocket,
  type HarWithExtensions,
  useMockHttpServer,
  type MockHttpServerFixture,
} from "@iterate-com/mock-http-proxy";
import { getProjectUrl } from "../../../events/src/lib/project-slug.ts";
import { mcpStreamableHttpGetStubHandlers } from "./mcp-streamable-http-get-stub-handlers.ts";
import { prepareAgentsHarForReplay } from "./prepare-agents-har-for-replay.ts";

export interface MockInternetHandle {
  url: string;
  getHar(): ReturnType<MockHttpServerFixture["getHar"]>;
  use: MockHttpServerFixture["use"];
}

export async function createMockInternet(opts: {
  harPath: string;
  eventsBaseUrl: string;
  eventsProjectSlug: string;
}): Promise<MockInternetHandle & AsyncDisposable> {
  const recordHar = process.env.AGENTS_E2E_RECORD_HAR === "1";
  const harExists = existsSync(opts.harPath);
  const replayMode = !recordHar && harExists;

  const mockServer = await useMockHttpServer({
    ...(recordHar
      ? {
          recorder: { harPath: opts.harPath },
          onUnhandledRequest: "bypass" as const,
        }
      : {
          onUnhandledRequest: "error" as const,
        }),
  });

  if (replayMode) {
    const eventsProjectHostname = new URL(
      getProjectUrl({
        currentUrl: opts.eventsBaseUrl,
        projectSlug: ProjectSlug.parse(opts.eventsProjectSlug),
      }).toString(),
    ).hostname;
    const harRaw = JSON.parse(await readFile(opts.harPath, "utf8")) as HarWithExtensions;
    const har = prepareAgentsHarForReplay(harRaw, eventsProjectHostname);
    mockServer.use(...fromTrafficWithWebSocket(har), ...mcpStreamableHttpGetStubHandlers);
  }

  if (recordHar) {
    // MCP stub handlers also needed during recording to avoid unhandled GET requests
    mockServer.use(...mcpStreamableHttpGetStubHandlers);
  }

  return {
    url: mockServer.url,
    getHar() {
      return mockServer.getHar();
    },
    use: mockServer.use.bind(mockServer),
    async [Symbol.asyncDispose]() {
      if (recordHar) {
        const har = normalizeHarForSnapshot(mockServer.getHar() as HarWithExtensions);
        await writeFile(opts.harPath, JSON.stringify(har, null, 2) + "\n");
        console.info(`[e2e] Recorded HAR to ${opts.harPath}`);
      }
      await mockServer.close();
    },
  };
}

const VOLATILE_RESPONSE_HEADERS = new Set([
  "cf-ray",
  "date",
  "age",
  "alt-svc",
  "nel",
  "report-to",
  "server-timing",
  "x-request-id",
]);

function normalizeHarForSnapshot(har: ReturnType<MockHttpServerFixture["getHar"]>) {
  const clone = JSON.parse(JSON.stringify(har)) as typeof har;

  for (const entry of clone.log.entries) {
    entry.startedDateTime = "1970-01-01T00:00:00.000Z";
    entry.time = 0;
    if (entry.timings) {
      for (const key of Object.keys(entry.timings)) {
        (entry.timings as unknown as Record<string, number>)[key] = 0;
      }
    }

    entry.response.headers = entry.response.headers
      .filter((h) => !VOLATILE_RESPONSE_HEADERS.has(h.name.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));

    entry.request.headers = entry.request.headers.sort((a, b) => a.name.localeCompare(b.name));
  }

  return clone;
}
