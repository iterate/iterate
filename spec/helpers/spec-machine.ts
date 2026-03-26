import { createHmac, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createWorkerClient } from "../../apps/daemon/server/orpc/client.ts";
import { buildSpecMachineEmail } from "../../apps/os/backend/email/spec-machine.ts";
import playwrightConfig from "../../playwright.config.ts";
import type { CreateMachineConfig } from "../../sandbox/providers/machine-stub.ts";

type RequestRecord = {
  method: string;
  path: string;
  headers: Record<string, string>;
  text: string;
  json?: unknown;
  machineExternalId?: string;
};

export type SpecMachineRequestHandler = (
  request: Request,
) => Response | undefined | Promise<Response | undefined>;

type ThreadMessage = {
  role: string;
  text: string;
};

type BootstrapEnvVars = {
  ITERATE_OS_BASE_URL: string;
  ITERATE_OS_API_KEY: string;
  ITERATE_MACHINE_ID: string;
};

type RuntimeState = {
  externalId: string;
  threads: Map<string, ThreadMessage[]>;
  files: Map<string, string>;
  directories: Set<string>;
  bootstrapEnvVars: BootstrapEnvVars | undefined;
  started: boolean;
};

function normalizeMachinePath(pathname: string) {
  const runtimeMatch = pathname.match(/^\/__spec-machine\/machines\/[^/]+(\/.*)$/);
  return (runtimeMatch?.[1] ?? pathname).replace(/^\/+/, "/");
}

function json(response: ServerResponse, statusCode: number, body: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

async function sendFetchResponse(response: ServerResponse, fetchResponse: Response) {
  response.statusCode = fetchResponse.status;
  fetchResponse.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });
  response.end(await fetchResponse.text());
}

async function readRequestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function signSvixMessage(params: { body: string; secret: string; id: string; timestamp: string }) {
  const secretBytes = Buffer.from(params.secret.split("_")[1] ?? "", "base64");
  const signedContent = `${params.id}.${params.timestamp}.${params.body}`;
  const signature = createHmac("sha256", secretBytes).update(signedContent).digest("base64");
  return `v1,${signature}`;
}

async function postWithManualRedirect(params: {
  url: string;
  headers: Record<string, string>;
  body: string;
}) {
  const response = await fetch(params.url, {
    method: "POST",
    headers: params.headers,
    body: params.body,
    redirect: "manual",
  });

  if (response.status < 300 || response.status >= 400) {
    return response;
  }

  const redirectLocation = response.headers.get("location");
  if (!redirectLocation) {
    return response;
  }

  return fetch(new URL(redirectLocation, params.url), {
    method: "POST",
    headers: params.headers,
    body: params.body,
    redirect: "manual",
  });
}

async function parseJsonResponse(response: Response) {
  const responseText = await response.text();
  const contentType = response.headers.get("content-type") ?? "unknown";

  if (!response.ok) {
    throw new Error(
      `Fake resend webhook failed: HTTP ${response.status} ${response.statusText} at ${response.url} (content-type: ${contentType})\n${responseText.slice(0, 500)}`,
    );
  }

  if (/<!DOCTYPE|<html/i.test(responseText)) {
    throw new Error(
      `Fake resend webhook returned HTML instead of JSON at ${response.url} (content-type: ${contentType})\n${responseText.slice(0, 500)}`,
    );
  }

  try {
    return JSON.parse(responseText);
  } catch (error) {
    throw new Error(
      `Fake resend webhook returned non-JSON response at ${response.url} (content-type: ${contentType})\n${responseText.slice(0, 500)}`,
      { cause: error },
    );
  }
}

async function getResendBotWebhookSecret() {
  let secret = process.env.RESEND_BOT_WEBHOOK_SECRET;
  if (!secret) {
    secret = execSync(`doppler secrets get RESEND_BOT_WEBHOOK_SECRET --plain`).toString().trim();
  }
  if (!secret) {
    throw new Error("RESEND_BOT_WEBHOOK_SECRET must be set for fake resend webhooks");
  }
  return secret;
}

export async function sendFakeResendWebhookPayload(payload: Record<string, unknown>) {
  const appUrl = playwrightConfig.use.baseURL;
  const body = JSON.stringify(payload);
  const secret = await getResendBotWebhookSecret();
  const id = `msg_${randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = {
    "Content-Type": "application/json",
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": signSvixMessage({ body, secret, id, timestamp }),
  };

  let response: Response | undefined;
  let lastError: unknown;

  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      response = await postWithManualRedirect({
        url: `${appUrl}/api/integrations/resend/webhook`,
        headers,
        body,
      });
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  if (!response) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return parseJsonResponse(response);
}

export type SpecMachine = {
  providerBaseUrl: string;
  senderEmail: string;
  requests: RequestRecord[];
  requestHandlers: SpecMachineRequestHandler[];
  sendFakeResendWebhook(params: { subject: string; text: string; from?: string }): Promise<unknown>;
  [Symbol.asyncDispose](): Promise<void>;
};

export async function createSpecMachine(): Promise<SpecMachine> {
  const requests: RequestRecord[] = [];
  const requestHandlers: SpecMachineRequestHandler[] = [];
  const runtimes = new Map<string, RuntimeState>();
  let latestRuntimeExternalId: string | undefined;
  let providerBaseUrl = "";

  async function reportReady(runtime: RuntimeState) {
    if (!runtime.bootstrapEnvVars) {
      throw new Error("Spec machine has not bootstrapped yet");
    }

    const previousBaseUrl = process.env.ITERATE_OS_BASE_URL;
    const previousApiKey = process.env.ITERATE_OS_API_KEY;
    const previousMachineId = process.env.ITERATE_MACHINE_ID;

    process.env.ITERATE_OS_BASE_URL = runtime.bootstrapEnvVars.ITERATE_OS_BASE_URL;
    process.env.ITERATE_OS_API_KEY = runtime.bootstrapEnvVars.ITERATE_OS_API_KEY;
    process.env.ITERATE_MACHINE_ID = runtime.bootstrapEnvVars.ITERATE_MACHINE_ID;

    try {
      const client = createWorkerClient();
      await client.machines.reportStatus({
        machineId: runtime.bootstrapEnvVars.ITERATE_MACHINE_ID,
        status: "ready",
      });
    } finally {
      process.env.ITERATE_OS_BASE_URL = previousBaseUrl;
      process.env.ITERATE_OS_API_KEY = previousApiKey;
      process.env.ITERATE_MACHINE_ID = previousMachineId;
    }
  }

  async function handleBootstrap(request: Request, runtime: RuntimeState) {
    if (
      request.method !== "POST" ||
      normalizeMachinePath(new URL(request.url).pathname) !== "/bootstrap"
    ) {
      return;
    }

    const body = (await request.json()) as { envVars: Record<string, string> };
    runtime.bootstrapEnvVars = {
      ITERATE_OS_BASE_URL: body.envVars.ITERATE_OS_BASE_URL,
      ITERATE_OS_API_KEY: body.envVars.ITERATE_OS_API_KEY,
      ITERATE_MACHINE_ID: body.envVars.ITERATE_MACHINE_ID,
    };
    await reportReady(runtime);
    return Response.json({ ok: true });
  }

  async function handleReadFile(request: Request, runtime: RuntimeState) {
    if (
      request.method !== "POST" ||
      normalizeMachinePath(new URL(request.url).pathname) !== "/api/orpc/tool/readFile"
    ) {
      return;
    }

    const body = (await request.json()) as { json: { path: string } };
    const content = runtime.files.get(body.json.path);
    return Response.json({
      json: {
        path: body.json.path,
        content: content ?? null,
        exists: !!content,
      },
    });
  }

  async function handleWriteFile(request: Request, runtime: RuntimeState) {
    if (
      request.method !== "POST" ||
      normalizeMachinePath(new URL(request.url).pathname) !== "/api/orpc/tool/writeFile"
    ) {
      return;
    }

    const body = (await request.json()) as { json: { path: string; content: string } };
    runtime.files.set(body.json.path, body.json.content);
    return Response.json({
      json: {
        path: body.json.path,
        bytesWritten: Buffer.byteLength(body.json.content),
      },
    });
  }

  async function handleExecCommand(request: Request, runtime: RuntimeState) {
    if (
      request.method !== "POST" ||
      normalizeMachinePath(new URL(request.url).pathname) !== "/api/orpc/tool/execCommand"
    ) {
      return;
    }

    const body = (await request.json()) as { json: { command: string[] } };
    const [command, ...args] = body.json.command;

    if (command === "test" && args[0] === "-d") {
      return Response.json({
        json: {
          exitCode: runtime.directories.has(args[1] ?? "") ? 0 : 1,
          stdout: "",
          stderr: "",
        },
      });
    }

    if (command === "git" && args[0] === "clone") {
      const targetPath = args.at(-1);
      if (targetPath) {
        runtime.directories.add(`${targetPath}/.git`);
      }
    }

    return Response.json({
      json: { exitCode: 0, stdout: "", stderr: "" },
    });
  }

  async function handleWebchatWebhook(request: Request, runtime: RuntimeState) {
    if (
      request.method !== "POST" ||
      normalizeMachinePath(new URL(request.url).pathname) !== "/api/integrations/webchat/webhook"
    ) {
      return;
    }

    const body = (await request.json()) as { threadId: string; text: string };
    const messages = runtime.threads.get(body.threadId) ?? [];
    messages.push({ role: "user", text: body.text });
    messages.push({ role: "assistant", text: "3" });
    runtime.threads.set(body.threadId, messages);
    return Response.json({ success: true, threadId: body.threadId });
  }

  function handleWebchatThread(request: Request, runtime: RuntimeState) {
    const pathname = normalizeMachinePath(new URL(request.url).pathname);
    if (request.method !== "GET" || !pathname.startsWith("/api/integrations/webchat/threads/")) {
      return;
    }

    const threadId = decodeURIComponent(pathname.split("/")[5] ?? "");
    return Response.json({ threadId, messages: runtime.threads.get(threadId) ?? [] });
  }

  function handleEmailWebhook(request: Request) {
    if (
      request.method !== "POST" ||
      normalizeMachinePath(new URL(request.url).pathname) !== "/api/integrations/email/webhook"
    ) {
      return;
    }

    return Response.json({ success: true });
  }

  async function dispatchRuntimeRequest(params: {
    runtime: RuntimeState;
    request: Request;
  }): Promise<Response | undefined> {
    const { runtime, request } = params;

    for (const handler of requestHandlers) {
      const handlerResult = await handler(request.clone());
      if (handlerResult) {
        return handlerResult;
      }
    }

    return (
      (await handleBootstrap(request.clone(), runtime)) ??
      (await handleReadFile(request.clone(), runtime)) ??
      (await handleWriteFile(request.clone(), runtime)) ??
      (await handleExecCommand(request.clone(), runtime)) ??
      (await handleWebchatWebhook(request.clone(), runtime)) ??
      handleWebchatThread(request.clone(), runtime) ??
      handleEmailWebhook(request.clone())
    );
  }

  async function createRuntime(config: CreateMachineConfig) {
    const runtime: RuntimeState = {
      externalId: config.externalId,
      threads: new Map<string, ThreadMessage[]>(),
      files: new Map<string, string>(),
      directories: new Set<string>(),
      bootstrapEnvVars: undefined,
      started: true,
    };
    runtimes.set(config.externalId, runtime);
    latestRuntimeExternalId = config.externalId;

    const bootstrapRequest = new Request(new URL("/bootstrap", providerBaseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    const bootstrapResponse = await dispatchRuntimeRequest({
      runtime,
      request: bootstrapRequest,
    });
    if (!bootstrapResponse?.ok) {
      throw new Error(`spec-machine bootstrap failed for ${config.externalId}`);
    }
  }

  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const text = await readRequestBody(request);
      const contentType = request.headers["content-type"] ?? "";
      let parsedJson: unknown;
      if (typeof contentType === "string" && contentType.includes("application/json") && text) {
        try {
          parsedJson = JSON.parse(text);
        } catch {
          parsedJson = undefined;
        }
      }

      const headers = Object.fromEntries(
        Object.entries(request.headers).flatMap(([key, value]) =>
          typeof value === "string" ? [[key, value]] : value ? [[key, value.join(",")]] : [],
        ),
      );

      if (method === "POST" && url.pathname === "/__spec-machine/machines") {
        const config = JSON.parse(text) as CreateMachineConfig;
        await createRuntime(config);
        json(response, 200, { ok: true, externalId: config.externalId });
        return;
      }

      const lifecycleMatch = url.pathname.match(
        /^\/__spec-machine\/machines\/([^/]+)\/__lifecycle\/(start|stop|restart)$/,
      );
      if (lifecycleMatch && method === "POST") {
        const externalId = decodeURIComponent(lifecycleMatch[1] ?? "");
        const action = lifecycleMatch[2];
        const runtime = runtimes.get(externalId);
        if (!runtime) {
          json(response, 404, { error: `Unknown machine ${externalId}` });
          return;
        }

        if (action === "start") {
          runtime.started = true;
        }
        if (action === "stop") {
          runtime.started = false;
        }
        if (action === "restart") {
          runtime.started = true;
        }

        json(response, 200, { ok: true, externalId, action });
        return;
      }

      const deleteMatch = url.pathname.match(/^\/__spec-machine\/machines\/([^/]+)$/);
      if (deleteMatch && method === "DELETE") {
        const externalId = decodeURIComponent(deleteMatch[1] ?? "");
        runtimes.delete(externalId);
        json(response, 200, { ok: true, externalId });
        return;
      }

      const runtimeMatch = url.pathname.match(/^\/__spec-machine\/machines\/([^/]+)(\/.*)$/);
      if (!runtimeMatch) {
        json(response, 404, { error: "Not found" });
        return;
      }

      const externalId = decodeURIComponent(runtimeMatch[1] ?? "");
      const runtimePath = normalizeMachinePath(runtimeMatch[0] ?? "/");
      const runtime = runtimes.get(externalId);
      if (!runtime) {
        json(response, 404, { error: `Unknown machine ${externalId}` });
        return;
      }

      if (!runtime.started) {
        json(response, 503, { error: `Machine ${externalId} is stopped` });
        return;
      }

      const requestRecord = {
        method,
        path: runtimePath,
        headers,
        text,
        json: parsedJson,
        machineExternalId: externalId,
      } satisfies RequestRecord;
      requests.push(requestRecord);

      const handlerRequest = new Request(new URL(runtimePath, providerBaseUrl), {
        method,
        headers: requestRecord.headers,
        body: method === "GET" || method === "HEAD" ? undefined : text,
      });
      const handlerResult = await dispatchRuntimeRequest({
        runtime,
        request: handlerRequest,
      });
      if (!handlerResult) {
        json(response, 404, { error: "Not found" });
        return;
      }

      await sendFetchResponse(response, handlerResult);
    } catch (error) {
      json(response, 500, { error: String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine spec machine address");
  }

  providerBaseUrl = `http://127.0.0.1:${address.port}`;
  const senderEmail = buildSpecMachineEmail({ providerBaseUrl });

  return {
    providerBaseUrl,
    senderEmail,
    requests,
    requestHandlers,
    async sendFakeResendWebhook(params: { subject: string; text: string; from?: string }) {
      const now = new Date().toISOString();
      return sendFakeResendWebhookPayload({
        type: "email.received",
        created_at: now,
        data: {
          email_id: `email_${randomUUID()}`,
          created_at: now,
          from: params.from ?? senderEmail,
          to: ["bot@example.com"],
          cc: [],
          bcc: [],
          message_id: `<${randomUUID()}@spec-machine>`,
          subject: params.subject,
          attachments: [],
        },
        _iterate_email_content: {
          text: params.text,
          html: null,
        },
      });
    },
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
