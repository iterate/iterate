import { createHmac, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createWorkerClient } from "../../apps/daemon/server/orpc/client.ts";
import { buildSpecMachineEmail } from "../../apps/os/backend/email/spec-machine.ts";

type RequestRecord = {
  method: string;
  path: string;
  headers: Record<string, string>;
  text: string;
  json?: unknown;
};

type ThreadMessage = {
  role: string;
  text: string;
};

function json(response: ServerResponse, statusCode: number, body: unknown) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
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

export class SpecMachine {
  private readonly server: Server;
  private readonly threads = new Map<string, ThreadMessage[]>();
  private readonly files = new Map<string, string>();
  private readonly directories = new Set<string>();
  private readonly requestsInternal: RequestRecord[] = [];

  public readonly baseUrl: string;
  public readonly senderEmail: string;

  private constructor(params: { server: Server; baseUrl: string }) {
    this.server = params.server;
    this.baseUrl = params.baseUrl;
    this.senderEmail = buildSpecMachineEmail({ baseUrl: this.baseUrl });
  }

  static async create() {
    const state = {
      requests: [] as RequestRecord[],
      threads: new Map<string, ThreadMessage[]>(),
      files: new Map<string, string>(),
      directories: new Set<string>(),
    };

    const server = createServer(async (request, response) => {
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

      state.requests.push({
        method,
        path: url.pathname,
        headers: Object.fromEntries(
          Object.entries(request.headers).flatMap(([key, value]) =>
            typeof value === "string" ? [[key, value]] : value ? [[key, value.join(",")]] : [],
          ),
        ),
        text,
        json: parsedJson,
      });

      if (method === "POST" && url.pathname === "/__spec-machine/bootstrap") {
        const body = parsedJson as { envVars: Record<string, string> };
        const previousBaseUrl = process.env.ITERATE_OS_BASE_URL;
        const previousApiKey = process.env.ITERATE_OS_API_KEY;
        const previousMachineId = process.env.ITERATE_MACHINE_ID;

        process.env.ITERATE_OS_BASE_URL = body.envVars.ITERATE_OS_BASE_URL;
        process.env.ITERATE_OS_API_KEY = body.envVars.ITERATE_OS_API_KEY;
        process.env.ITERATE_MACHINE_ID = body.envVars.ITERATE_MACHINE_ID;

        try {
          const client = createWorkerClient();
          await client.machines.reportStatus({
            machineId: body.envVars.ITERATE_MACHINE_ID,
            status: "ready",
          });
        } finally {
          process.env.ITERATE_OS_BASE_URL = previousBaseUrl;
          process.env.ITERATE_OS_API_KEY = previousApiKey;
          process.env.ITERATE_MACHINE_ID = previousMachineId;
        }

        return json(response, 200, { ok: true });
      }

      if (method === "POST" && url.pathname === "/api/orpc/tool/readFile") {
        const body = parsedJson as { json: { path: string } };
        const content = state.files.get(body.json.path);
        return json(response, 200, {
          path: body.json.path,
          content: content ?? null,
          exists: !!content,
        });
      }

      if (method === "POST" && url.pathname === "/api/orpc/tool/writeFile") {
        const body = parsedJson as { json: { path: string; content: string } };
        state.files.set(body.json.path, body.json.content);
        return json(response, 200, {
          path: body.json.path,
          bytesWritten: Buffer.byteLength(body.json.content),
        });
      }

      if (method === "POST" && url.pathname === "/api/orpc/tool/execCommand") {
        const body = parsedJson as { json: { command: string[] } };
        const [command, ...args] = body.json.command;

        if (command === "test" && args[0] === "-d") {
          return json(response, 200, {
            exitCode: state.directories.has(args[1] ?? "") ? 0 : 1,
            stdout: "",
            stderr: "",
          });
        }

        if (command === "git" && args[0] === "clone") {
          const targetPath = args.at(-1);
          if (targetPath) {
            state.directories.add(`${targetPath}/.git`);
          }
        }

        return json(response, 200, { exitCode: 0, stdout: "", stderr: "" });
      }

      if (method === "POST" && url.pathname === "/api/integrations/webchat/webhook") {
        const body = parsedJson as { threadId: string; text: string };
        const messages = state.threads.get(body.threadId) ?? [];
        messages.push({ role: "user", text: body.text });
        messages.push({ role: "assistant", text: "3" });
        state.threads.set(body.threadId, messages);
        return json(response, 200, { success: true, threadId: body.threadId });
      }

      if (method === "GET" && url.pathname.startsWith("/api/integrations/webchat/threads/")) {
        const threadId = decodeURIComponent(url.pathname.split("/")[5] ?? "");
        return json(response, 200, { threadId, messages: state.threads.get(threadId) ?? [] });
      }

      if (method === "POST" && url.pathname === "/api/integrations/email/webhook") {
        return json(response, 200, { success: true });
      }

      json(response, 404, { error: "Not found" });
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to determine spec machine address");
    }

    const specMachine = new SpecMachine({
      server,
      baseUrl: `http://127.0.0.1:${address.port}`,
    });
    specMachine.requestsInternal.push(...state.requests);
    specMachine.threads.clear();
    for (const [key, value] of state.threads) specMachine.threads.set(key, value);
    specMachine.files.clear();
    for (const [key, value] of state.files) specMachine.files.set(key, value);
    specMachine.directories.clear();
    for (const value of state.directories) specMachine.directories.add(value);
    return specMachine;
  }

  get requests() {
    return this.requestsInternal;
  }

  async sendFakeResendWebhook(params: { subject: string; text: string }) {
    const appUrl = process.env.APP_URL || "http://localhost:5173";
    const now = new Date().toISOString();
    const body = JSON.stringify({
      type: "email.received",
      created_at: now,
      data: {
        email_id: `email_${randomUUID()}`,
        created_at: now,
        from: this.senderEmail,
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

    const secret = process.env.RESEND_BOT_WEBHOOK_SECRET;
    if (!secret) {
      throw new Error("RESEND_BOT_WEBHOOK_SECRET must be set for fake resend webhooks");
    }

    const id = `msg_${randomUUID()}`;
    const timestamp = String(Math.floor(Date.now() / 1000));

    const response = await fetch(`${appUrl}/api/integrations/resend/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "svix-id": id,
        "svix-timestamp": timestamp,
        "svix-signature": signSvixMessage({ body, secret, id, timestamp }),
      },
      body,
    });

    if (!response.ok) {
      throw new Error(
        `Fake resend webhook failed: HTTP ${response.status} ${await response.text()}`,
      );
    }

    return response.json();
  }

  async [Symbol.asyncDispose]() {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

export async function createSpecMachine() {
  return SpecMachine.create();
}
