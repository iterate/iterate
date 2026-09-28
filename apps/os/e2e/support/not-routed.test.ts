// not-routed.test.ts — the e2e transport's resend of what Cloudflare answered itself, against a
// local server that plays a brand-new hostname's edge: its first answers Cloudflare's not-found,
// then the Worker's. Which answers are Cloudflare's is platform-retry.test.ts's table.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { listenOnFetchSafePort } from "@iterate-com/shared/test-support/fetch-safe-port";
import {
  Agent,
  Client,
  fetch as undiciFetch,
  getGlobalDispatcher,
  setGlobalDispatcher,
  WebSocket,
} from "undici";
import { CI_HTTP } from "@iterate-com/shared/platform-retry";
import { expect, onTestFinished, test, vi } from "vitest";
import { resendNotRoutedYet } from "./not-routed.ts";

test.for([
  { name: "a GET answered with the not-found page", method: "GET", answers: ["page", "worker"] },
  {
    name: "a POST answered with the page twice, its body sent whole each time",
    method: "POST",
    body: "email=a%40example.com&password=p",
    answers: ["page", "page", "worker"],
  },
  { name: "a GET answered error code: 1104", method: "GET", answers: ["1104", "worker"] },
  { name: "a GET answered error code: 1042", method: "GET", answers: ["1042", "worker"] },
] satisfies { name: string; method: string; body?: string; answers: Answer[] }[])(
  "resend: $name gets the Worker's answer, each resend on a fresh connection after CI_HTTP's wait",
  async ({ method, body, answers }) => {
    await using edge = await fakeEdge(answers);
    const transport = resending();
    const response = await undiciFetch(edge.url("/login"), {
      method,
      body,
      dispatcher: transport.dispatcher,
    });
    expect({ status: response.status, text: await response.text() }).toEqual({
      status: 200,
      text: "the worker",
    });
    expect(edge).toMatchObject({
      requests: answers.map((_, index) => ({
        method,
        path: "/login",
        body: body || "",
        socket: index,
      })),
    });
    // Math.random at 1: each wait is its schedule's whole, unjittered
    expect({
      waits: transport.waits,
      connections: transport.connections.length,
      warns: transport.warns,
    }).toMatchObject({
      waits: CI_HTTP.delaysMs.slice(0, answers.length - 1),
      connections: answers.length - 1,
      warns: answers.slice(1).map((_, index) => ({
        event: "e2e.platform-failure-retry",
        kind: "disconnected",
        request: `${method} ${edge.url("/login")}`,
        attempt: index + 1,
        retryInMs: CI_HTTP.delaysMs[index],
      })),
    });
  },
);

test.for([
  { name: "its JSON 404", answer: "worker-404-json" },
  {
    name: "its own Page not found page, which carries no x-preview-user-error",
    answer: "worker-404-page",
  },
  { name: "its plain 404 of a few bytes", answer: "worker-404-plain" },
  { name: "its plain 500 that starts like a code", answer: "worker-500-long" },
] satisfies { name: string; answer: Answer }[])(
  "pass-through: the Worker's $name reaches the caller from the first attempt, with no wait",
  async ({ answer }) => {
    await using edge = await fakeEdge([answer]);
    const transport = resending();
    const response = await undiciFetch(edge.url("/x"), { dispatcher: transport.dispatcher });
    const expected = ANSWERS[answer];
    expect({ status: response.status, text: await response.text() }).toEqual({
      status: expected.status,
      text: expected.body,
    });
    expect({ requests: edge.requests.length, warns: transport.warns }).toEqual({
      requests: 1,
      warns: [],
    });
  },
);

test.for([
  { name: "the not-found page", answer: "page" },
  { name: "error code: 1042", answer: "1042" },
  { name: "error code: 1104", answer: "1104" },
] satisfies { name: string; answer: Answer }[])(
  "resend: the connection that answered $name is dropped, so the next request goes on a new one",
  async ({ answer }) => {
    await using edge = await fakeEdge([answer, "worker", "worker"]);
    const transport = resending();
    for (const path of ["/first", "/second"]) {
      const response = await undiciFetch(edge.url(path), { dispatcher: transport.dispatcher });
      await response.text();
    }
    // the second request's own connection: never the one Cloudflare answered on, 0
    expect(edge).toMatchObject({
      requests: [
        { path: "/first", socket: 0 },
        { path: "/first", socket: 1 },
        { path: "/second", socket: 2 },
      ],
    });
  },
);

test("resend: a WebSocket upgrade answered with the not-found page opens on a fresh connection, which outlives its Client", async () => {
  await using edge = await fakeEdge(["page", "worker"]);
  const transport = resending();
  const socket = new WebSocket(edge.url("/api").replace("http:", "ws:"), {
    dispatcher: transport.dispatcher,
  });
  onTestFinished(() => socket.close());
  // the edge's first frame comes 100 ms after the upgrade: the resend's Client is closed by then
  const received = await new Promise<string>((resolve) => {
    socket.addEventListener("message", (event) => resolve(`message: ${event.data}`));
    socket.addEventListener("error", (event) => resolve(`error: ${event.message}`));
  });
  expect({ received, upgrades: edge.requests, connections: transport.connections }).toMatchObject({
    received: "message: hello",
    upgrades: [
      { method: "GET", path: "/api", socket: 0 },
      { method: "GET", path: "/api", socket: 1 },
    ],
    connections: [edge.url("/api").replace(/\/api$/, "")],
  });
});

test("resend: Node's own fetch, through the global dispatcher, sends a sign-in POST again", async () => {
  await using edge = await fakeEdge(["page", "worker"]);
  const transport = resending();
  const previous = getGlobalDispatcher();
  setGlobalDispatcher(transport.dispatcher);
  onTestFinished(() => setGlobalDispatcher(previous));
  const response = await fetch(edge.url("/login"), {
    method: "POST",
    body: new URLSearchParams({ email: "a@example.com", password: "p" }),
  });
  expect({ status: response.status, requests: edge.requests }).toMatchObject({
    status: 200,
    requests: [
      { method: "POST", body: "email=a%40example.com&password=p", socket: 0 },
      { method: "POST", body: "email=a%40example.com&password=p", socket: 1 },
    ],
  });
});

test("resend: a hostname Cloudflare still does not route after the schedule fails the request, naming the answer", async () => {
  await using edge = await fakeEdge(["page", "page", "page", "page"]);
  const transport = resending();
  const failed = await undiciFetch(edge.url("/version"), {
    dispatcher: transport.dispatcher,
  }).catch((error: Error) => error);
  expect({
    cause: (failed as Error & { cause?: Error }).cause?.message,
    requests: edge.requests.length,
    lines: transport.warns.map((line) => line.event),
  }).toMatchObject({
    cause: expect.stringMatching(
      /^GET http:\/\/127\.0\.0\.1:\d+\/version: Cloudflare answered 404 x-preview-user-error on 4 connections: the servers they reached do not route 127\.0\.0\.1:\d+ yet$/,
    ),
    requests: 4,
    lines: [
      "e2e.platform-failure-retry",
      "e2e.platform-failure-retry",
      "e2e.platform-failure-retry",
      "e2e.platform-failure-gave-up",
    ],
  });
});

test("resend: a caller that aborts during the wait gets its AbortError, and nothing is sent again", async () => {
  await using edge = await fakeEdge(["page", "worker"]);
  const transport = resending({ holdWaits: true });
  const caller = new AbortController();
  const response = undiciFetch(edge.url("/version"), {
    dispatcher: transport.dispatcher,
    signal: caller.signal,
  }).catch((error: Error) => error.name);
  await vi.waitFor(() => expect(transport.warns).toHaveLength(1));
  caller.abort();
  const outcome = await response;
  transport.releaseWaits();
  // outlasts the resend a finished wait would dispatch at once
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect({ outcome, requests: edge.requests.length }).toEqual({
    outcome: "AbortError",
    requests: 1,
  });
});

type Answer = keyof typeof ANSWERS;

/** What the edge answers, by name: Cloudflare's three not-founds (the page as it serves it), and
 *  the Worker's own answers, one each shaped like one of them. */
const ANSWERS = {
  page: {
    status: 404,
    headers: { "content-type": "text/html", "x-preview-user-error": "true", "cf-ray": "abc-MXP" },
    body: '<!DOCTYPE html>\n<html><head><meta http-equiv="refresh" content="30"><title>Page not found</title></head><body><h1>There is nothing here yet</h1></body></html>',
  },
  "1104": {
    status: 500,
    headers: { "content-type": "text/plain; charset=UTF-8" },
    body: "error code: 1104",
  },
  "1042": {
    status: 404,
    headers: { "content-type": "text/plain; charset=UTF-8" },
    body: "error code: 1042",
  },
  worker: { status: 200, headers: { "content-type": "text/plain" }, body: "the worker" },
  "worker-404-json": {
    status: 404,
    headers: { "content-type": "application/json" },
    body: '{"error":"not found"}',
  },
  "worker-404-page": {
    status: 404,
    headers: { "content-type": "text/html" },
    body: "<!DOCTYPE html><html><head><title>Page not found</title></head><body><h1>Page not found</h1></body></html>",
  },
  "worker-404-plain": { status: 404, headers: { "content-type": "text/plain" }, body: "no route" },
  "worker-500-long": {
    status: 500,
    headers: { "content-type": "text/plain" },
    body: "error code: 1104, and then a sentence of the Worker's own",
  },
};

/** The interceptor on an Agent of its own, its waits recorded instead of waited (held until
 *  `releaseWaits`, for the abort row) and never jittered, and the warns it logs captured. */
function resending(options: { holdWaits?: boolean } = {}) {
  const waits: number[] = [];
  const connections: string[] = [];
  const held: (() => void)[] = [];
  vi.spyOn(Math, "random").mockReturnValue(1);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const agent = new Agent();
  onTestFinished(() => agent.close());
  return {
    dispatcher: agent.compose(
      resendNotRoutedYet({
        pause: (ms) => {
          waits.push(ms);
          if (!options.holdWaits) return Promise.resolve();
          return new Promise<void>((resolve) => held.push(resolve));
        },
        connect: (origin) => {
          connections.push(String(origin));
          return new Client(origin, { allowH2: false });
        },
      }),
    ),
    waits,
    connections,
    releaseWaits: () => held.splice(0).forEach((release) => release()),
    get warns() {
      return warn.mock.calls.map(([line]) => line as { event: string; retryInMs?: number });
    },
  };
}

/** A local server answering `answers` in turn, to requests and WebSocket upgrades alike (the last
 *  repeats), and recording each request with the connection it came on, numbered in order. */
async function fakeEdge(answers: Answer[]) {
  const requests: { method: string; path: string; body: string; socket: number }[] = [];
  const sockets = new Map<Socket, number>();
  const upgraded: Socket[] = [];
  let answered = 0;
  const next = () => ANSWERS[answers[Math.min(answered++, answers.length - 1)]!];
  const record = (request: IncomingMessage, body: string) => {
    if (!sockets.has(request.socket)) sockets.set(request.socket, sockets.size);
    requests.push({
      method: request.method!,
      path: request.url!,
      body,
      socket: sockets.get(request.socket)!,
    });
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    record(request, Buffer.concat(chunks).toString());
    const answer = next();
    response
      .writeHead(answer.status, {
        ...answer.headers,
        "content-length": Buffer.byteLength(answer.body),
      })
      .end(answer.body);
  });
  server.on("upgrade", (request: IncomingMessage, socket: Socket) => {
    record(request, "");
    const answer = next();
    if (answer.status !== 200) {
      const head = Object.entries({
        ...answer.headers,
        "content-length": Buffer.byteLength(answer.body),
      })
        .map(([name, value]) => `${name}: ${value}`)
        .join("\r\n");
      socket.end(`HTTP/1.1 ${answer.status} Not Found\r\n${head}\r\n\r\n${answer.body}`);
      return;
    }
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    upgraded.push(socket);
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
    );
    // one unmasked text frame, "hello"
    setTimeout(() => socket.write(Buffer.from([0x81, 5, ...Buffer.from("hello")])), 100);
  });
  const port = await listenOnFetchSafePort(server);
  return {
    requests,
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    async [Symbol.asyncDispose]() {
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
