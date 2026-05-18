import { HttpResponse, http, type HarWithExtensions } from "@iterate-com/mock-http-proxy";

const MCP_POST_URLS = new Set([
  "https://docs.mcp.cloudflare.com/mcp",
  "https://mcp.canuckduck.ca/mcp",
]);

type HarEntry = HarWithExtensions["log"]["entries"][number];

type JsonRpcRequest = {
  method?: unknown;
};

export function withoutMcpStreamableHttpPostEntries(har: HarWithExtensions): HarWithExtensions {
  return {
    ...har,
    log: {
      ...har.log,
      entries: har.log.entries.filter((entry) => !isMcpStreamableHttpPost(entry)),
    },
  };
}

export function mcpStreamableHttpPostHarHandlers(har: HarWithExtensions) {
  const replay = createMcpReplayQueue(har.log.entries.filter(isMcpStreamableHttpPost));

  return [
    http.post("https://docs.mcp.cloudflare.com/mcp", async ({ request }) =>
      handleMcpReplayPost(request, replay),
    ),
    http.post("https://mcp.canuckduck.ca/mcp", async ({ request }) =>
      handleMcpReplayPost(request, replay),
    ),
  ];
}

function isMcpStreamableHttpPost(entry: HarEntry): boolean {
  return entry.request.method === "POST" && MCP_POST_URLS.has(entry.request.url);
}

function createMcpReplayQueue(entries: HarEntry[]) {
  const entriesByRequest = new Map<string, HarEntry[]>();
  for (const entry of entries) {
    const method = inferJsonRpcMethodFromLegacyHarEntry(entry);
    if (!method) continue;
    const key = mcpReplayKey({ url: entry.request.url, method });
    const existing = entriesByRequest.get(key) ?? [];
    existing.push(entry);
    entriesByRequest.set(key, existing);
  }

  return {
    next(args: { url: string; method: string }): HarEntry | undefined {
      return entriesByRequest.get(mcpReplayKey(args))?.shift();
    },
  };
}

function mcpReplayKey(args: { url: string; method: string }) {
  return `${args.url}\u0000${args.method}`;
}

function inferJsonRpcMethodFromLegacyHarEntry(entry: HarEntry): string | null {
  if (entry.response.status === 202) return "notifications/initialized";

  const text = entry.response.content.text ?? "";
  if (text.includes('"protocolVersion"')) return "initialize";
  if (text.includes('"content"')) return "tools/call";
  if (text.includes('"tools"')) return "tools/list";
  if (text.includes('"prompts"')) return "prompts/list";
  return null;
}

async function handleMcpReplayPost(
  request: { json(): Promise<unknown>; url: string },
  replay: ReturnType<typeof createMcpReplayQueue>,
) {
  const body = (await request.json()) as JsonRpcRequest;
  if (typeof body.method !== "string") {
    return HttpResponse.json({ error: "MCP JSON-RPC request missing method" }, { status: 400 });
  }

  const entry = replay.next({ url: request.url, method: body.method });
  if (!entry) {
    return HttpResponse.json(
      { error: `No MCP HAR response left for ${body.method} at ${request.url}` },
      { status: 502 },
    );
  }

  return new HttpResponse(entry.response.content.text ?? null, {
    status: entry.response.status,
    headers: Object.fromEntries(entry.response.headers.map((h) => [h.name, h.value])),
  });
}
