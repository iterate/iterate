import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import {
  fromTrafficWithWebSocket,
  HttpResponse,
  http,
  type HarWithExtensions,
  useMockHttpServer,
  type MockHttpServerFixture,
} from "@iterate-com/mock-http-proxy";

type MockHttpHandler = Parameters<MockHttpServerFixture["use"]>[number];

interface MockInternetHandle {
  getHar(): ReturnType<MockHttpServerFixture["getHar"]>;
  url: string;
  use: MockHttpServerFixture["use"];
}

export async function createMockInternet(opts: {
  harPath: string;
  handlers?: MockHttpHandler[];
  host?: string;
  prepareHarForReplay?: (har: HarWithExtensions) => HarWithExtensions;
  port?: number;
}): Promise<MockInternetHandle & AsyncDisposable> {
  const harExists = existsSync(opts.harPath);
  const recordHar = process.env.OS_E2E_RECORD_HAR === "1" || !harExists;
  const replayMode = !recordHar && harExists;

  const mockServer = await useMockHttpServer({
    host: opts.host,
    ...(recordHar
      ? {
          recorder: { harPath: opts.harPath },
          onUnhandledRequest: "bypass" as const,
        }
      : {
          onUnhandledRequest: "error" as const,
        }),
    port: opts.port,
  });

  if (replayMode) {
    const harRaw = JSON.parse(await readFile(opts.harPath, "utf8")) as HarWithExtensions;
    const har = opts.prepareHarForReplay ? opts.prepareHarForReplay(harRaw) : harRaw;
    mockServer.use(...localConsolePipeHandlers, ...(opts.handlers ?? []));
    mockServer.use(...fromTrafficWithWebSocket(har));
  } else {
    mockServer.use(...localConsolePipeHandlers, ...(opts.handlers ?? []));
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

export function rewriteHarHostnames(
  archive: HarWithExtensions,
  rewrite: (hostname: string) => string | null,
): HarWithExtensions {
  const clone = JSON.parse(JSON.stringify(archive)) as HarWithExtensions;

  for (const entry of clone.log.entries) {
    entry.request.url = rewriteUrlHostname(entry.request.url, rewrite);
    entry.response.headers = entry.response.headers.filter(
      (header) => header.name.toLowerCase() !== "content-length",
    );
  }

  return clone;
}

const localConsolePipeHandlers = [
  http.post(/^http:\/\/localhost:\d+\/__tsd\/console-pipe\/server$/, () => new HttpResponse(null)),
];

const VOLATILE_RESPONSE_HEADERS = new Set([
  "age",
  "alt-svc",
  "cf-ray",
  "date",
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
      .filter((header) => !VOLATILE_RESPONSE_HEADERS.has(header.name.toLowerCase()))
      .sort((left, right) => left.name.localeCompare(right.name));

    entry.request.headers = entry.request.headers.sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  return clone;
}

function rewriteUrlHostname(
  urlString: string,
  rewrite: (hostname: string) => string | null,
): string {
  try {
    const url = new URL(urlString);
    const nextHostname = rewrite(url.hostname);
    if (nextHostname) {
      url.hostname = nextHostname;
      return url.toString();
    }
  } catch {
    return urlString;
  }
  return urlString;
}
