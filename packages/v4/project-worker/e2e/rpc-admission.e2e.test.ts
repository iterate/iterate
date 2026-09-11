// `/api` must reject pathological wire structure before Capnweb's JSON.parse materializes it.
// This frame is deliberately small on the wire but would allocate many tiny containers if parsed.
import { request as httpRequest, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { expect, test } from "vitest";
import { WebSocket as UndiciWebSocket } from "undici";
import { workerAuthHeaders, workerUrl } from "./support/client.ts";
import {
  traceUndiciHandshake,
  undiciErrorSurface,
} from "./support/undici-handshake-diagnostics.ts";

// The scanner refuses this before JSON.parse. Its small wire size isolates the WebSocket abort
// lifecycle from the dense-frame resource test below.
const tooDeepFrame = `${"[".repeat(257)}${"]".repeat(257)}`;
// 2m empty containers are ~6 MiB on the wire. That fits the existing harness's proven WS-message
// capacity but exceeds the 32 MiB decoded-structure estimate.
const denseFrame = `[${new Array(2_000_000).fill("[]").join(",")}]`;

test("HTTP batch refuses an over-complex RPC frame before it starts a session", async () => {
  const response = await fetch(workerUrl("/api"), {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: denseFrame,
  });

  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({
    code: "RPC_ADMISSION_REJECTED",
    kind: "MESSAGE_TOO_COMPLEX",
  });
});

async function expectFiniteAdmissionRefusal(): Promise<void> {
  let sourceDeadline: ReturnType<typeof setTimeout> | undefined;
  let sourceClosed = false;
  const abort = new AbortController();
  const url = new URL(workerUrl("/api"));
  const started = performance.now();
  let hardDeadline: ReturnType<typeof setTimeout> | undefined;
  let request: ClientRequest | undefined;
  try {
    const response = await Promise.race([
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const auth = workerAuthHeaders(url) ?? {};
        const dial = url.protocol === "https:" ? httpsRequest : httpRequest;
        request = dial(
          url.toString(),
          {
            method: "POST",
            headers: {
              "content-type": "text/plain",
              "transfer-encoding": "chunked",
              ...auth,
            },
            signal: abort.signal,
          },
          (rawResponse) => {
            let body = "";
            rawResponse.setEncoding("utf8");
            rawResponse.on("data", (chunk: string) => (body += chunk));
            rawResponse.on("end", () => resolve({ status: rawResponse.statusCode ?? 0, body }));
          },
        );
        request.on("error", reject);
        request.write(tooDeepFrame);
        sourceDeadline = setTimeout(() => {
          sourceClosed = true;
          request?.end();
        }, 1_000);
      }),
      new Promise<never>((_resolve, reject) => {
        hardDeadline = setTimeout(() => {
          abort.abort();
          request?.destroy();
          reject(new Error("admission response exceeded its 5s hard deadline"));
        }, 5_000);
      }),
    ]);
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({
      code: "RPC_ADMISSION_REJECTED",
      kind: "MESSAGE_TOO_COMPLEX",
    });
    expect(performance.now() - started).toBeLessThan(2_000);
  } finally {
    if (hardDeadline) clearTimeout(hardDeadline);
    if (sourceDeadline) clearTimeout(sourceDeadline);
    if (!sourceClosed) request?.end();
    abort.abort();
    request?.destroy();
  }
}

test("HTTP returns its classified refusal promptly after a finite rejected upload closes", async () => {
  await expectFiniteAdmissionRefusal();
});

async function admissionClose(frame: string): Promise<{
  event: CloseEvent;
  opened: boolean;
  errored: boolean;
  errorDetail: string;
  errorReadyState: number | undefined;
  endpoint: string;
  handshake: string;
}> {
  const url = new URL(workerUrl("/api"));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const authHeaders = workerAuthHeaders(url);
  // Match every capnweb E2E session's explicit Undici transport. The test still validates the
  // raw admission wire directly; it does not rely on an ambient Node WebSocket implementation.
  const diagnostics = traceUndiciHandshake(url);
  const socket = new UndiciWebSocket(url.toString(), {
    ...(authHeaders ? { headers: authHeaders } : undefined),
  });
  diagnostics.setSocket(socket);
  let opened = false;
  let errored = false;
  let errorDetail = "none";
  let errorReadyState: number | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<CloseEvent>((resolve, reject) => {
    timeout = setTimeout(() => {
      try {
        socket.close();
      } finally {
        reject(new Error("admission close timed out"));
      }
    }, 10_000);
    socket.addEventListener("close", (event) => {
      if (timeout) clearTimeout(timeout);
      resolve(event);
    });
  });
  socket.addEventListener("open", () => {
    opened = true;
    socket.send(frame);
  });
  socket.addEventListener("error", (event) => {
    errored = true;
    errorReadyState = socket.readyState;
    const error = event as ErrorEvent;
    errorDetail = error.message || undiciErrorSurface(error.error) || event.type;
  });

  try {
    return {
      event: await closed,
      opened,
      errored,
      errorDetail,
      errorReadyState,
      endpoint: `undici:${url.origin}${url.pathname}`,
      handshake: diagnostics.detail(),
    };
  } finally {
    diagnostics.dispose();
    if (timeout) clearTimeout(timeout);
    if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
      try {
        socket.close();
      } catch {
        // The transport failed while the test was observing it.
      }
    }
  }
}

test("WebSocket closes an over-nested RPC frame with an admission classification", async () => {
  const result = await admissionClose(tooDeepFrame);
  const transportDetail = `endpoint=${result.endpoint} close=${result.event.code} opened=${result.opened} errored=${result.errored} errorState=${result.errorReadyState} error=${result.errorDetail} reason=${result.event.reason} handshake=${result.handshake}`;
  expect(result.opened, transportDetail).toBe(true);
  expect(result.event.code, transportDetail).toBe(3000);
  expect(result.event.reason).toContain("RPC_ADMISSION_REJECTED:MESSAGE_TOO_COMPLEX");
});

test("WebSocket reports the same admission diagnostic for a six-megabyte dense frame", async () => {
  const result = await admissionClose(denseFrame);
  const transportDetail = `endpoint=${result.endpoint} close=${result.event.code} opened=${result.opened} errored=${result.errored} errorState=${result.errorReadyState} error=${result.errorDetail} reason=${result.event.reason} handshake=${result.handshake}`;
  expect(result.opened, transportDetail).toBe(true);
  expect(result.event.code, transportDetail).toBe(3000);
  expect(result.event.reason).toContain("RPC_ADMISSION_REJECTED:MESSAGE_TOO_COMPLEX");
});

test("a finite rejected upload leaves the next public admission upgrade healthy", async () => {
  await expectFiniteUploadUpgradeSequence();
});

async function expectFiniteUploadUpgradeSequence(): Promise<void> {
  const started = performance.now();
  // The local assets regression first failed at cycles 21–23 in isolation; ten cycles missed it.
  // These are distinct sequential requests, not retries: the first unhealthy upgrade fails the test.
  for (let index = 0; index < 32; index += 1) {
    await expectFiniteAdmissionRefusal();
    const result = await admissionClose(tooDeepFrame);
    const transportDetail = `iteration=${index} elapsedMs=${(performance.now() - started).toFixed(1)} endpoint=${result.endpoint} close=${result.event.code} opened=${result.opened} errored=${result.errored} errorState=${result.errorReadyState} error=${result.errorDetail} reason=${result.event.reason} handshake=${result.handshake}`;
    expect(result.opened, transportDetail).toBe(true);
    expect(result.event.code, transportDetail).toBe(3000);
    expect(result.event.reason).toContain("RPC_ADMISSION_REJECTED:MESSAGE_TOO_COMPLEX");
  }
}
