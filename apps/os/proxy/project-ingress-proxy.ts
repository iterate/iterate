import { DurableObject } from "cloudflare:workers";
import { Daytona } from "@daytonaio/sdk";
import { getDbWithEnv } from "../backend/db/client.ts";
import * as schema from "../backend/db/schema.ts";
import type { ProxyWorkerBindings } from "./worker.ts";

const HOP_BY_HOP_HEADERS = [
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailers",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "x-iterate-machine-id",
  "x-iterate-port",
];

const EXCLUDE_RESPONSE_HEADERS = ["transfer-encoding", "connection", "keep-alive"];

export class ProjectIngressProxy extends DurableObject {
  declare env: ProxyWorkerBindings;

  async fetch(request: Request): Promise<Response> {
    const machineId = request.headers.get("X-Iterate-Machine-Id");
    const portStr = request.headers.get("X-Iterate-Port");

    if (!machineId || !portStr) {
      return new Response("Missing machine info", { status: 400 });
    }

    const port = Number(portStr);
    const db = getDbWithEnv(this.env);

    // Look up machine with its preview token (same token works for all ports)
    const machine = await db.query.machine.findFirst({
      where: (t, { eq }) => eq(t.id, machineId),
      columns: { externalId: true, type: true },
      with: {
        previewTokens: {
          columns: { token: true },
          limit: 1,
        },
      },
    });

    console.log("Machine", machine);
    if (!machine) {
      return new Response("Machine not found", { status: 404 });
    }

    if (machine.type !== "daytona") {
      return new Response("Only Daytona machines are supported", { status: 400 });
    }

    let token = machine.previewTokens[0]?.token;

    // Backfill token if not stored
    if (!token) {
      try {
        const daytona = new Daytona({ apiKey: this.env.DAYTONA_API_KEY });
        const sandbox = await daytona.get(machine.externalId);
        const previewInfo = await sandbox.getPreviewLink(3000);
        token = previewInfo.token;

        // Store for future requests
        await db
          .insert(schema.daytonaPreviewToken)
          .values({ machineId, port: "0", token })
          .onConflictDoUpdate({
            target: [schema.daytonaPreviewToken.machineId, schema.daytonaPreviewToken.port],
            set: { token, updatedAt: new Date() },
          });
      } catch {
        return new Response("Failed to get preview token", { status: 500 });
      }
    }

    // Construct preview URL and proxy
    const previewUrl = `https://${port}-${machine.externalId}.proxy.daytona.works`;
    const url = new URL(request.url);
    const targetUrl = `${previewUrl}${url.pathname}${url.search}`;

    if (request.url.endsWith("/ws")) {
      console.log("Target URL", targetUrl);
      console.log("Request", request);
    }
    return this.proxyRequest(request, targetUrl, token);
  }

  private async proxyRequest(
    request: Request,
    targetUrl: string,
    token: string,
  ): Promise<Response> {
    const url = new URL(targetUrl);

    // Handle WebSocket upgrades
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      console.log("WebSocket upgrade detected");
      return this.proxyWebSocket(request, targetUrl, token);
    }

    const headers = new Headers();
    request.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    });

    headers.set("X-Daytona-Preview-Token", token);
    headers.set("X-Daytona-Skip-Preview-Warning", "true");
    headers.set("Host", url.host);

    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.body,
      // @ts-expect-error - Cloudflare Workers support duplex streaming
      duplex: "half",
    });

    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      if (!EXCLUDE_RESPONSE_HEADERS.includes(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    });

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  }

  private async proxyWebSocket(
    request: Request,
    targetUrl: string,
    token: string,
  ): Promise<Response> {
    const url = new URL(targetUrl);
    const headers = new Headers();

    console.log("WebSocket upgrade detected 2");

    // Forward WebSocket-specific headers from the original request
    request.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.startsWith("sec-websocket-") ||
        lowerKey === "origin" ||
        lowerKey === "upgrade" ||
        lowerKey === "connection"
      ) {
        headers.set(key, value);
      }
    });

    // Add Daytona auth headers
    headers.set("X-Daytona-Preview-Token", token);
    headers.set("X-Daytona-Skip-Preview-Warning", "true");
    headers.set("Host", url.host);

    return fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.body,
    });
  }
}
