import { createServer, type IncomingMessage } from "node:http";

export async function startSlackResponseServer() {
  const posts: Array<{ text: string }> = [];
  const server = createServer(async (request, response) => {
    posts.push(JSON.parse(await readRequestBody(request)) as { text: string });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address == null || typeof address === "string") {
    throw new Error("Expected a TCP address for the mock Slack server");
  }

  return {
    posts,
    responseUrl: `http://127.0.0.1:${address.port}/slack/reply`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export function createSlackWebhook({
  responseUrl,
  text,
  triggerId = "1337.42",
}: {
  responseUrl: string;
  text: string;
  triggerId?: string;
}) {
  return {
    channel_id: "C123",
    channel_name: "alerts",
    command: "/iterate",
    response_url: responseUrl,
    team_domain: "iterate",
    team_id: "T123",
    text,
    token: "slack-token",
    trigger_id: triggerId,
    user_id: "U123",
    user_name: "jonas",
  };
}

export async function postRawJsonToStream({
  baseUrl,
  body,
  projectSlug,
  streamPath,
}: {
  baseUrl: string;
  body: unknown;
  projectSlug: string;
  streamPath: string;
}) {
  const response = await fetch(new URL(`/api/streams${streamPath}`, baseUrl), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-iterate-project": projectSlug },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Raw append failed with ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<{ event: { payload: { rawInput: unknown }; type: string } }>;
}

export async function waitForSlackPost(
  server: Awaited<ReturnType<typeof startSlackResponseServer>>,
  count: number,
  { timeoutMs = 120_000 }: { timeoutMs?: number } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.posts.length >= count) {
      return server.posts[count - 1]!;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Slack post ${count}`);
}

export async function waitForSlackPostMatching(
  server: Awaited<ReturnType<typeof startSlackResponseServer>>,
  predicate: (post: { text: string }) => boolean,
  { timeoutMs = 120_000 }: { timeoutMs?: number } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = server.posts.find(predicate);
    if (match != null) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for matching Slack post");
}

export function destroyLingeringSockets() {
  const getHandles = Reflect.get(process, "_getActiveHandles");
  const handles = typeof getHandles === "function" ? getHandles.call(process) : undefined;
  if (!Array.isArray(handles)) {
    return;
  }

  for (const handle of handles) {
    if (
      typeof handle === "object" &&
      handle != null &&
      "constructor" in handle &&
      handle.constructor?.name === "Socket" &&
      "destroy" in handle &&
      typeof handle.destroy === "function"
    ) {
      handle.destroy();
    }
  }
}

async function readRequestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
