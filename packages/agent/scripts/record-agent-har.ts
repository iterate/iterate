import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chat } from "@tanstack/ai";
import { openaiText } from "@tanstack/ai-openai";

const harUrl = new URL("../src/fixtures/agent-send-message.har", import.meta.url);
const harPath = fileURLToPath(harUrl);

await mkdir(dirname(harPath), { recursive: true });

const originalFetch = globalThis.fetch;
const harEntries: Array<Record<string, unknown>> = [];

globalThis.fetch = async (input, init) => {
  const startedAt = Date.now();
  const request = new Request(input, init);
  const requestClone = request.clone();
  const requestBody =
    request.method === "GET" || request.method === "HEAD" ? "" : await requestClone.text();
  const response = await originalFetch(request);
  const responseBody = await response.clone().text();
  const requestUrl = new URL(request.url);

  harEntries.push({
    startedDateTime: new Date(startedAt).toISOString(),
    time: Date.now() - startedAt,
    request: {
      method: request.method,
      url: request.url,
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: Array.from(request.headers.entries()).map(([name, value]) => ({
        name,
        value: name.toLowerCase() === "authorization" ? "Bearer sk-agent-test" : value,
      })),
      queryString: Array.from(requestUrl.searchParams.entries()).map(([name, value]) => ({
        name,
        value,
      })),
      ...(requestBody
        ? {
            postData: {
              mimeType: request.headers.get("content-type") ?? "application/json",
              text: requestBody,
            },
          }
        : {}),
      headersSize: -1,
      bodySize: Buffer.byteLength(requestBody),
    },
    response: {
      status: response.status,
      statusText: response.statusText,
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: Array.from(response.headers.entries())
        .filter(([name]) => name.toLowerCase() !== "content-encoding")
        .map(([name, value]) => ({ name, value })),
      content: {
        size: Buffer.byteLength(responseBody),
        mimeType: response.headers.get("content-type") ?? "application/json",
        text: responseBody,
      },
      redirectURL: "",
      headersSize: -1,
      bodySize: Buffer.byteLength(responseBody),
    },
    cache: {},
    timings: {
      send: 0,
      wait: Date.now() - startedAt,
      receive: 0,
    },
  });

  return response;
};

const response = await chat({
  adapter: openaiText("gpt-5.2"),
  systemPrompts: [
    "You are a general purpose AI agent built using the iterate agent harness.",
    "All actions you take are accomplished by producing ```ts blocks that contain the code to execute.",
    "Each LLM response you make MUST include _exactly one_ ```ts block",
    "To communicate with the user, use `ctx.sendMessage({ message: string })`",
  ],
  messages: [
    {
      role: "user",
      content:
        "Say hello to the user by returning exactly one ts block that calls ctx.sendMessage.",
    },
  ],
  stream: false,
});

await writeFile(
  harPath,
  `${JSON.stringify(
    {
      log: {
        version: "1.2",
        creator: {
          name: "packages/agent/record-agent-har",
          version: "0.0.1",
        },
        entries: harEntries,
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(response);
